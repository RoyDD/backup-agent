import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LocalExecutor } from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'

import { runCli } from '../src/cli'

/**
 * The goal loop against a live instance.
 *
 * These tests exist because the loop's central claim is that it is not a second
 * execution path: `goal run` re-enters the same CLI entry point, so the real
 * `inspect` and `backup` commands, the real destructive gate, the real lease and
 * the real run-lifecycle recording all apply. A fake executor cannot prove that;
 * it only proves the loop's own bookkeeping.
 *
 * Credentials travel through `BKAGENT_DSN`, never through a step action: an
 * action is persisted, and the stored copy is what a resumed run would dispatch.
 *
 * The default DSN is the repository's integration instance (see AGENTS.md). Set
 * `BK_TEST_DSN` to point at another PostgreSQL.
 */
const DSN = process.env.BK_TEST_DSN ?? 'postgres://postgres:verify_pw@127.0.0.1:55416/postgres'

const workspaces: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bkagent-goal-live-'))
  workspaces.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

async function cli(argv: readonly string[]): Promise<CliResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    executor: new LocalExecutor(),
    env: { BKAGENT_DSN: DSN },
  })
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

async function json<T>(argv: readonly string[]): Promise<{ code: number; value: T }> {
  const result = await cli(argv)
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new Error(
      `expected JSON from \`${argv.join(' ')}\`, got exit ${result.code}: ${result.stdout}${result.stderr}`,
    )
  }
  return { code: result.code, value: value as T }
}

interface GoalView {
  goalId: string
  state: string
  goalState?: string
  steps?: { stepId: string; ordinal: number; state: string; action: { command: string } }[]
  executed?: {
    stepId: string
    attempt: number
    exitCode: number | null
    errorClass: string | null
    signature: string | null
    state: string
  }[]
  recovered?: { stepId: string; signature: string }[]
  diagnosis?: {
    signature: string
    errorClass: string
    candidates: { kind: string }[]
  }
  progress?: { total: number; succeeded: number; failed: number }
}

const kinds = (value: GoalView): string[] =>
  value.diagnosis?.candidates.map((candidate) => candidate.kind) ?? []

describe('goal loop against a live instance', () => {
  it('runs a decomposed goal through the real inspect and backup commands', async () => {
    const dir = workspace()
    const db = join(dir, 'control.db')
    const dump = join(dir, 'app.dump')
    const target = 'pg16-live'

    const steps = [
      {
        intent: 'prove the instance answers before writing anything',
        action: { command: 'inspect', args: [] },
      },
      {
        intent: 'take a custom-format dump of the postgres database',
        action: {
          command: 'backup',
          args: ['--database', 'postgres', '--out', dump, '--format', 'custom'],
        },
        dependsOn: [1],
      },
    ]

    const created = await json<GoalView>([
      'goal',
      'add',
      '--db',
      db,
      '--target',
      target,
      '--intent',
      'back up the postgres database after inspecting the instance',
      '--steps-json',
      JSON.stringify(steps),
    ])
    expect(created.code).toBe(0)
    expect(created.value.state).toBe('planned')
    expect(created.value.steps?.map((step) => step.ordinal)).toEqual([0, 1])

    const run = await json<GoalView>(['goal', 'run', '--db', db, '--goal', created.value.goalId])
    expect(run.code).toBe(0)
    expect(run.value.state).toBe('succeeded')
    expect(run.value.executed?.map((entry) => entry.state)).toEqual(['succeeded', 'succeeded'])
    expect(run.value.progress).toEqual(
      expect.objectContaining({ total: 2, succeeded: 2, failed: 0 }),
    )

    // The artifact is real bytes, produced by the real pg_dump inside the loop.
    expect(statSync(dump).size).toBeGreaterThan(0)

    // Every step left a durable attempt row and a memory entry.
    const repo = await createSqliteRepository({ filename: db })
    try {
      const stored = await repo.goalSteps.listByGoal(created.value.goalId as never)
      expect(stored.map((step) => step.state)).toEqual(['succeeded', 'succeeded'])
      for (const step of stored) {
        const attempts = await repo.stepAttempts.listByStep(step.stepId)
        expect(attempts).toHaveLength(1)
        expect(attempts[0]?.state).toBe('succeeded')
        expect(attempts[0]?.exitCode).toBe(0)
      }
      const memory = await repo.memory.list({ targetId: target as never, limit: 10 })
      expect(memory).toHaveLength(2)
      expect(memory.every((entry) => entry.success)).toBe(true)
      // Long-term memory must not carry the DSN password, and neither must the
      // stored decomposition: credentials never enter an action.
      expect(JSON.stringify(memory)).not.toContain('verify_pw')
      expect(JSON.stringify(stored)).not.toContain('verify_pw')
    } finally {
      await repo.close()
    }
  })

  it('diagnoses a permanent failure, replans the step, and finishes', async () => {
    const dir = workspace()
    const db = join(dir, 'control.db')
    const dump = join(dir, 'app.dump')

    const created = await json<GoalView>([
      'goal',
      'add',
      '--db',
      db,
      '--target',
      'pg16-live',
      '--intent',
      'dump a database that does not exist, then correct the plan',
      '--steps-json',
      JSON.stringify([
        {
          intent: 'dump a database that is not there',
          action: {
            command: 'backup',
            args: [
              '--database',
              'bkagent_missing_database',
              '--out',
              dump,
              '--format',
              'custom',
            ],
          },
        },
      ]),
    ])
    expect(created.code).toBe(0)

    const failed = await json<GoalView>(['goal', 'run', '--db', db, '--goal', created.value.goalId])
    expect(failed.code).toBe(1)
    expect(failed.value.executed?.[0]?.state).toBe('failed')
    // The control plane's own verdict, read from the inner JSON envelope, keeps
    // the catalogued signature instead of degrading to `exit:1`.
    expect(failed.value.diagnosis?.signature).toBe('schema:database-missing')
    expect(kinds(failed.value)).toContain('replan')
    expect(kinds(failed.value)).not.toContain('retry')

    const shown = await json<GoalView>(['goal', 'show', '--db', db, '--goal', created.value.goalId])
    const stepId = shown.value.steps?.[0]?.stepId
    expect(stepId).toBeTypeOf('string')

    const corrected = await json<GoalView>([
      'goal',
      'remediate',
      '--db',
      db,
      '--step',
      stepId as string,
      '--kind',
      'replan',
      '--action-json',
      JSON.stringify({
        command: 'backup',
        args: ['--database', 'postgres', '--out', dump, '--format', 'custom'],
      }),
    ])
    expect(corrected.code).toBe(0)
    expect(corrected.value.goalState).toBe('planned')

    const done = await json<GoalView>(['goal', 'run', '--db', db, '--goal', created.value.goalId])
    expect(done.code).toBe(0)
    expect(done.value.state).toBe('succeeded')
    expect(statSync(dump).size).toBeGreaterThan(0)
  })

  it('refuses a destructive step that no human approved, before dispatching anything', async () => {
    const dir = workspace()
    const db = join(dir, 'control.db')

    // The goal does not allow destructive steps, so the decomposition is refused
    // outright rather than stored and then blocked at run time.
    const refused = await json<GoalView>([
      'goal',
      'add',
      '--db',
      db,
      '--target',
      'pg16-live',
      '--intent',
      'restore without approval',
      '--steps-json',
      JSON.stringify([
        {
          intent: 'restore a dump',
          action: { command: 'restore', args: ['--input', join(dir, 'missing.dump')] },
        },
      ]),
    ])
    expect(refused.code).toBe(4)

    const allowed = await json<GoalView>([
      'goal',
      'add',
      '--db',
      db,
      '--target',
      'pg16-live',
      '--intent',
      'restore without approval, but the goal permits destructive steps',
      '--constraints-json',
      JSON.stringify({ allowDestructive: true }),
      '--steps-json',
      JSON.stringify([
        {
          intent: 'restore a dump',
          action: { command: 'restore', args: ['--input', join(dir, 'missing.dump')] },
        },
      ]),
    ])
    expect(allowed.code).toBe(0)

    const run = await json<GoalView>(['goal', 'run', '--db', db, '--goal', allowed.value.goalId])
    expect(run.code).toBe(1)
    expect(run.value.diagnosis?.signature).toBe('approval:required')
    expect(kinds(run.value)).toEqual(['escalate'])

    // Nothing was dispatched: the step is still ready for a later, approved run.
    const shown = await json<GoalView>(['goal', 'show', '--db', db, '--goal', allowed.value.goalId])
    expect(shown.value.steps?.[0]?.state).toBe('ready')
  })
})
