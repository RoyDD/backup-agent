import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createHandlers, createRunner } from '../runner.js'
import { DEFAULT_CLI } from '../tools.js'

/**
 * The decision-layer replay gate.
 *
 * This is not a model test. It replays a fixed sequence of decisions through
 * the same entry points a model uses — `TOOL_DEFINITIONS.buildArgv` in
 * `runner.js`, a real `dist/bkagent.mjs` child process, the real control
 * database, the real PostgreSQL instance — and asserts the loop's contract:
 * which `hint` each decision produces, and that the payload survives a
 * non-zero exit.
 *
 * The distinction matters. A model-level replay (recorded model responses fed
 * back through the host) would prove what some model did once; it would not
 * prove that today's tool surface still carries the diagnosis, because the
 * recorded response already contains it. Replaying decisions keeps the
 * assertion on the code we own.
 *
 * Prerequisites, both checked per test so a missing one is a reported skip
 * rather than a silent pass:
 *
 * - `pnpm build:cli` (the tool runner executes `dist/bkagent.mjs`);
 * - a reachable PostgreSQL (`BK_TEST_DSN`, default 55416).
 */

const DSN =
  process.env.BK_TEST_DSN ?? 'postgres://postgres:verify_pw@127.0.0.1:55416/postgres'

const workspaces = []
let previousDsn

beforeAll(() => {
  previousDsn = process.env.BKAGENT_DSN
  // Credentials travel through the environment, never through a step action:
  // an action is persisted and replayed.
  process.env.BKAGENT_DSN = DSN
})

afterAll(() => {
  if (previousDsn === undefined) delete process.env.BKAGENT_DSN
  else process.env.BKAGENT_DSN = previousDsn
})

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'bkagent-replay-'))
  workspaces.push(dir)
  return dir
}

function dsnEndpoint(dsn) {
  const match = /^postgres(?:ql)?:\/\/(?:[^@/]*@)?([^:/]+)(?::(\d+))?\//.exec(dsn)
  return { host: match?.[1] ?? '127.0.0.1', port: Number(match?.[2] ?? 5432) }
}

async function canConnect(host, port, timeoutMs = 1000) {
  return await new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function ready(context) {
  const migrations = join(dirname(DEFAULT_CLI), 'migrations')
  if (!existsSync(DEFAULT_CLI) || !existsSync(migrations)) {
    context.skip('dist/bkagent.mjs is missing; run `pnpm build:cli` before the replay gate')
    return false
  }
  const { host, port } = dsnEndpoint(DSN)
  if (!(await canConnect(host, port))) {
    context.skip(`PostgreSQL not reachable at ${host}:${port}`)
    return false
  }
  return true
}

/** The same handler map the dsh plugin and the MCP server are built from. */
const tools = createHandlers(createRunner({ cliPath: DEFAULT_CLI }))

const goal = (args) => tools.goal(args)
const stepRun = (args) => tools.stepRun(args)
const remediate = (args) => tools.remediate(args)
const recall = (args) => tools.recall(args)

const TARGET = 'pg16-live'

describe('goal loop replay (decision layer)', () => {
  it('replays a successful goal and ends on hint=done', async (context) => {
    if (!(await ready(context))) return
    const dir = workspace()
    const db = join(dir, 'control.db')
    const dump = join(dir, 'app.dump')

    const opened = await goal({
      op: 'open',
      target: TARGET,
      intent: '检查实例后备份 postgres 库',
      steps: [
        { intent: '证明实例可应答', action: { command: 'inspect', args: [] } },
        {
          intent: '取一份 custom 格式转储',
          action: {
            command: 'backup',
            args: ['--database', 'postgres', '--out', dump, '--format', 'custom'],
          },
          dependsOn: [1],
        },
      ],
      db,
    })
    // Opening a goal makes the first step runnable; nothing has run yet.
    expect(opened.next.kind).toBe('run')
    expect(opened.goalId).toMatch(/^gol_/)

    const run = await stepRun({ goal: opened.goalId, db })
    expect(run.state).toBe('succeeded')
    expect(run.executed.map((entry) => entry.state)).toEqual(['succeeded', 'succeeded'])
    // `hint` is what the model acts on; `next` alone cannot say "stop".
    expect(run.next).toEqual({ kind: 'done', failed: false })
    expect(run.hint).toBe('done')
    // The loop is not a second execution path: real bytes came out of it.
    expect(statSync(dump).size).toBeGreaterThan(0)
  })

  it('replays a permanent failure through diagnose, replan and success', async (context) => {
    if (!(await ready(context))) return
    const dir = workspace()
    const db = join(dir, 'control.db')
    const dump = join(dir, 'app.dump')

    const opened = await goal({
      op: 'open',
      target: TARGET,
      intent: '转储一个不存在的库，然后修正计划',
      steps: [
        {
          intent: '转储不存在的库',
          action: {
            command: 'backup',
            args: [
              '--database',
              'bkagent_replay_missing_db',
              '--out',
              dump,
              '--format',
              'custom',
            ],
          },
        },
      ],
      db,
    })

    const failed = await stepRun({ goal: opened.goalId, db })
    // A failed run still exits non-zero, and the payload must survive it.
    expect(failed.exitCode).toBe(1)
    expect(failed.diagnosis.signature).toBe('schema:database-missing')
    expect(failed.hint).toBe('remediate')
    expect(failed.diagnosis.candidates.map((candidate) => candidate.kind)).toContain('replan')

    const stepId = failed.executed[0].stepId
    const corrected = await remediate({
      step: stepId,
      kind: 'replan',
      action: {
        command: 'backup',
        args: ['--database', 'postgres', '--out', dump, '--format', 'custom'],
      },
      reason: '库名写错了',
      db,
    })
    expect(corrected.goalState).toBe('planned')
    // The replacement action is ready: the loop continues without asking again.
    expect(corrected.hint).toBe('run_step')

    const done = await stepRun({ goal: opened.goalId, db })
    expect(done.state).toBe('succeeded')
    expect(done.hint).toBe('done')
    expect(statSync(dump).size).toBeGreaterThan(0)

    // Memory flowed back: the failed signature and the outcome are retrievable.
    const remembered = await recall({ target: TARGET, db })
    const signatures = remembered.hits.map((hit) => hit.signature)
    expect(signatures).toContain('schema:database-missing')
    expect(signatures).toContain('ok')
  })

  it('replays an unapproved destructive step as await_approval, never as a workaround', async (context) => {
    if (!(await ready(context))) return
    const dir = workspace()
    const db = join(dir, 'control.db')

    const opened = await goal({
      op: 'open',
      target: TARGET,
      intent: '恢复一份转储，但先不审批',
      constraints: { allowDestructive: true },
      steps: [
        {
          intent: '恢复到新库',
          action: { command: 'restore', args: ['--input', join(dir, 'missing.dump')] },
        },
      ],
      db,
    })

    const run = await stepRun({ goal: opened.goalId, db })
    expect(run.exitCode).toBe(1)
    expect(run.diagnosis.signature).toBe('approval:required')
    expect(run.executed).toEqual([])
    expect(run.hint).toBe('await_approval')

    // `replan` is not offered for an approval failure: otherwise "self
    // correction" would be a way to route around four-eyes with another action.
    const stepId = run.diagnosis.stepId
    const replan = await remediate({
      step: stepId,
      kind: 'replan',
      action: { command: 'inspect', args: [] },
      db,
    })
    expect(replan.exitCode).toBe(4)
    expect(replan.refused).toContain('escalate')

    // Escalating ends the agent's part: the goal is terminal, so the loop stops.
    const escalated = await remediate({ step: stepId, kind: 'escalate', reason: '交人工审批', db })
    expect(escalated.goalState).toBe('failed')
    expect(escalated.hint).toBe('done')
  })
})
