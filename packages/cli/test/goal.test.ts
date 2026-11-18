import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asGoalId, asGoalStepId, asTargetId, type Goal, type GoalStep } from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'
import { FakeExecutor } from '@backup-agent/core/testkit'

import { runCli } from '../src/cli'
import { runGoalCommand, type GoalCommandDeps } from '../src/goal'

// An action may not carry a password: a goal is persisted and replayed, so the
// credential belongs in BKAGENT_DSN / .pgpass / peer / GSSAPI.
const DSN = 'postgres://backup@127.0.0.1:55416/app'
const DSN_WITH_PASSWORD = 'postgres://backup:s3cret@127.0.0.1:55416/app'
const BASIC = JSON.stringify({
  version: 'PostgreSQL 16.15',
  serverVersionNum: 160015,
  currentUser: 'backup',
  currentDatabase: 'app',
  inRecovery: false,
  walLevel: 'replica',
  archiveMode: 'on',
  databases: ['app'],
})

function capture(): {
  stdout: string[]
  stderr: string[]
  write: (text: string) => void
  writeError: (text: string) => void
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    write: (text) => stdout.push(text),
    writeError: (text) => stderr.push(text),
  }
}

/** Probes successfully: the basic query plus the optional identity query. */
function successExecutor(): FakeExecutor {
  return new FakeExecutor({
    defaultHandler: (cmd) => {
      if (cmd.some((arg) => arg.includes('json_build_object'))) return { stdout: BASIC }
      if (cmd.some((arg) => arg.includes('pg_control_system'))) {
        return { stdout: '7421000000000000001' }
      }
      return { stdout: '' }
    },
  })
}

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<{ dir: string; db: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bkagent-goal-'))
  workspaces.push(dir)
  return { dir, db: join(dir, 'control.db') }
}

async function withRepo<T>(file: string, fn: (repo: Awaited<ReturnType<typeof createSqliteRepository>>) => Promise<T>): Promise<T> {
  const repo = await createSqliteRepository({ filename: file })
  await repo.migrate()
  try {
    return await fn(repo)
  } finally {
    await repo.close()
  }
}

type DispatchHandler = (
  argv: readonly string[],
  stdout: (text: string) => void,
  stderr: (text: string) => void,
) => Promise<number>

interface CommandResult {
  code: number
  stdout: string
  stderr: string
  /** Every argv this command handed to the CLI's own entry point. */
  dispatched: string[][]
}

async function goal(
  args: readonly string[],
  options: { executor?: FakeExecutor; env?: NodeJS.ProcessEnv; dispatch?: DispatchHandler } = {},
): Promise<CommandResult> {
  const out = capture()
  const dispatched: string[][] = []
  const env = options.env ?? {}
  const dispatch: GoalCommandDeps['dispatch'] = async (argv, stdout, stderr) => {
    dispatched.push([...argv])
    if (options.dispatch !== undefined) return options.dispatch(argv, stdout, stderr)
    return runCli(argv, {
      stdout,
      stderr,
      env,
      ...(options.executor === undefined ? {} : { executor: options.executor }),
    })
  }
  const code = await runGoalCommand('goal', args, {
    write: out.write,
    writeError: out.writeError,
    env,
    dispatch,
  })
  return { code, stdout: out.stdout.join(''), stderr: out.stderr.join(''), dispatched }
}

async function memory(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  const out = capture()
  const code = await runGoalCommand('memory', args, {
    write: out.write,
    writeError: out.writeError,
    env,
    dispatch: async () => 0,
  })
  return { code, stdout: out.stdout.join(''), stderr: out.stderr.join(''), dispatched: [] }
}

function parse<T>(text: string): T {
  return JSON.parse(text) as T
}

interface AddedGoal {
  goalId: string
  state: string
  steps?: { stepId: string; ordinal: number; state: string; dependsOn: string[] }[]
  next?: { kind: string; stepId?: string }
  prior?: { kind: string }
}

interface RunPayload {
  goalId: string
  state: string
  executed: {
    stepId: string
    attempt: number
    exitCode: number | null
    errorClass: string | null
    signature: string | null
    state: string
  }[]
  diagnosis?: {
    errorClass: string
    signature: string
    candidates: { kind: string }[]
    requiresHuman: boolean
  }
  progress: { total: number; succeeded: number; failed: number; blocked: number }
  next: { kind: string; stepId?: string; stepIds?: string[]; failed?: boolean }
}

const INSPECT_STEP = { intent: 'inspect the app', action: { command: 'inspect', args: ['--dsn', DSN] } }

async function addGoal(
  db: string,
  steps: readonly unknown[],
  options: { target?: string; constraints?: unknown } = {},
): Promise<AddedGoal> {
  const result = await goal([
    'add',
    '--db',
    db,
    '--target',
    options.target ?? 'app-1',
    '--intent',
    'keep the app backed up',
    '--steps-json',
    JSON.stringify(steps),
    ...(options.constraints === undefined
      ? []
      : ['--constraints-json', JSON.stringify(options.constraints)]),
  ])
  expect(result.code).toBe(0)
  return parse<AddedGoal>(result.stdout)
}

async function storedGoal(db: string, goalId: string): Promise<Goal | null> {
  return withRepo(db, async (repo) => repo.goals.get(asGoalId(goalId)))
}

async function storedSteps(db: string, goalId: string): Promise<GoalStep[]> {
  return withRepo(db, async (repo) => repo.goalSteps.listByGoal(asGoalId(goalId)))
}

describe('bkagent goal add', () => {
  it('persists a decomposition with ordinals and resolved dependencies', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [
      { intent: 'inspect the primary', action: { command: 'inspect', args: ['--dsn', DSN] } },
      {
        intent: 'inspect again once the first passed',
        action: { command: 'inspect', args: ['--dsn', DSN] },
        dependsOn: [1],
      },
    ])

    expect(added.state).toBe('planned')
    expect(added.prior).toEqual({ kind: 'empty' })
    expect(added.next).toEqual({ kind: 'run', stepId: added.steps?.[0]?.stepId })

    const steps = await storedSteps(w.db, added.goalId)
    expect(steps.map((step) => step.ordinal)).toEqual([0, 1])
    expect(steps[0]?.state).toBe('pending')
    expect(steps[1]?.dependsOn).toEqual([steps[0]?.stepId])
    // The action is stored as the grammar allowed it: no credential in argv.
    expect(steps[0]?.action.args).toContain(DSN)
  })

  it('refuses a decomposition that smuggles --yes into a step', async () => {
    const w = await workspace()
    const result = await goal([
      'add',
      '--db',
      w.db,
      '--target',
      'app-1',
      '--intent',
      'restore it',
      '--steps-json',
      JSON.stringify([
        {
          intent: 'restore',
          action: { command: 'restore', args: ['--dsn', DSN, '--input', '/tmp/dump.sql', '--yes'] },
        },
      ]),
    ])

    expect(result.code).toBe(4)
    const payload = parse<{ issues: { step: number; field: string; message: string }[] }>(result.stdout)
    expect(payload.issues.length).toBeGreaterThan(0)
    expect(payload.issues.some((issue) => issue.message.includes('--yes'))).toBe(true)
    // Nothing was written: a rejected plan leaves no goal behind.
    expect(await withRepo(w.db, async (repo) => repo.goals.list())).toEqual([])
  })
})

describe('bkagent goal run', () => {
  it('runs a two-step goal to success and records memory', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [
      { intent: 'inspect once', action: { command: 'inspect', args: ['--dsn', DSN] } },
      { intent: 'inspect twice', action: { command: 'inspect', args: ['--dsn', DSN] } },
    ])

    const result = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      executor: successExecutor(),
    })
    expect(result.code).toBe(0)
    const payload = parse<RunPayload>(result.stdout)
    expect(payload.state).toBe('succeeded')
    expect(payload.executed.map((step) => step.state)).toEqual(['succeeded', 'succeeded'])
    expect(payload.progress).toMatchObject({ total: 2, succeeded: 2, failed: 0 })

    expect((await storedGoal(w.db, added.goalId))?.state).toBe('succeeded')
    const steps = await storedSteps(w.db, added.goalId)
    expect(steps.map((step) => step.state)).toEqual(['succeeded', 'succeeded'])
    expect(await withRepo(w.db, async (repo) => repo.memory.list({ targetId: asTargetId('app-1') })))
      .toHaveLength(2)
  })

  it('retries a transient failure and succeeds on the second attempt', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [INSPECT_STEP])

    let probes = 0
    const executor = new FakeExecutor({
      defaultHandler: (cmd) => {
        if (cmd.some((arg) => arg.includes('json_build_object'))) {
          probes += 1
          if (probes === 1) {
            return {
              exitCode: 2,
              stderr: 'psql: error: could not connect to server: Connection refused',
            }
          }
          return { stdout: BASIC }
        }
        if (cmd.some((arg) => arg.includes('pg_control_system'))) {
          return { stdout: '7421000000000000001' }
        }
        return { stdout: '' }
      },
    })

    const result = await goal(['run', '--db', w.db, '--goal', added.goalId], { executor })
    expect(result.code).toBe(0)
    const payload = parse<RunPayload>(result.stdout)
    // One failed dispatch (exit 3 -> transient) then a successful retry.
    expect(payload.executed.map((step) => step.state)).toEqual(['failed', 'succeeded'])
    expect(payload.executed[0]?.signature).toBe('connect:refused')

    const steps = await storedSteps(w.db, added.goalId)
    expect(steps[0]?.attempts).toBe(2)
    expect(steps[0]?.state).toBe('succeeded')
  })

  it('stops on a permanent failure with replan as the only forward candidate', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [INSPECT_STEP])

    const result = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      dispatch: async (_argv, _stdout, stderr) => {
        stderr('psql: error: database "app" does not exist\n')
        return 1
      },
    })

    expect(result.code).toBe(1)
    const payload = parse<RunPayload>(result.stdout)
    expect(payload.diagnosis?.signature).toBe('schema:database-missing')
    expect(payload.diagnosis?.candidates.map((candidate) => candidate.kind)).toContain('replan')
    expect(payload.diagnosis?.candidates.map((candidate) => candidate.kind)).not.toContain('retry')

    const steps = await storedSteps(w.db, added.goalId)
    expect(steps[0]?.state).toBe('failed')
    expect(steps[0]?.lastErrorClass).toBe('permanent')
    expect((await storedGoal(w.db, added.goalId))?.state).toBe('running')
  })

  it('classifies from the control plane verdict on stdout, not the exit code', async () => {
    const w = await workspace()
    const dump = join(w.dir, 'dump.sql')
    const added = await addGoal(w.db, [
      {
        intent: 'dump the app',
        action: { command: 'backup', args: ['--dsn', DSN, '--out', dump, '--format', 'plain'] },
      },
    ])

    // The dump fails: the inner CLI exits 1 and writes the plan result (with the
    // step's real stderr) to stdout, so `exit:1` would be the wrong verdict.
    const executor = new FakeExecutor({
      defaultHandler: (cmd) => {
        if (cmd.some((arg) => arg.includes('json_build_object'))) return { stdout: BASIC }
        if (cmd.some((arg) => arg.includes('pg_control_system'))) {
          return { stdout: '7421000000000000001' }
        }
        return { exitCode: 1, stderr: 'pg_dump: error: FATAL: database "app" does not exist' }
      },
    })

    const result = await goal(['run', '--db', w.db, '--goal', added.goalId], { executor })
    expect(result.code).toBe(1)
    const payload = parse<RunPayload>(result.stdout)
    expect(payload.diagnosis?.errorClass).toBe('permanent')
    expect(payload.diagnosis?.signature).toBe('schema:database-missing')
    expect(payload.diagnosis?.candidates.map((candidate) => candidate.kind)).toContain('replan')
    expect(payload.executed[0]?.signature).toBe('schema:database-missing')

    const attempts = await withRepo(w.db, async (repo) =>
      repo.stepAttempts.listByStep(asGoalStepId(added.steps?.[0]?.stepId as string)),
    )
    expect(attempts.map((attempt) => attempt.signature)).toEqual(['schema:database-missing'])
  })

  it('recovers a step left running by a crashed run', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [INSPECT_STEP])
    const stepId = added.steps?.[0]?.stepId as string

    // Simulate a process that died after moving the step to `running`: the
    // attempt was counted, but no terminal row was ever written.
    await withRepo(w.db, async (repo) => {
      await repo.goalSteps.update(
        asGoalStepId(stepId),
        { state: 'running', attempts: 1 },
        '2026-01-01T00:00:00.000Z',
      )
    })

    const result = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      executor: successExecutor(),
    })
    expect(result.code).toBe(1)
    // The stalled step is settled, not dispatched again.
    expect(result.dispatched).toEqual([])

    const payload = parse<RunPayload & { recovered?: { stepId: string; signature: string }[] }>(
      result.stdout,
    )
    expect(payload.recovered).toEqual([{ stepId, signature: 'stalled' }])
    expect(payload.state).toBe('failed')

    const steps = await storedSteps(w.db, added.goalId)
    expect(steps[0]?.state).toBe('failed')
    expect(steps[0]?.lastErrorClass).toBe('permanent')

    const attempts = await withRepo(w.db, async (repo) =>
      repo.stepAttempts.listByStep(asGoalStepId(stepId)),
    )
    expect(attempts.map((attempt) => [attempt.state, attempt.signature, attempt.errorClass])).toEqual([
      ['failed', 'stalled', 'permanent'],
    ])
    expect(attempts[0]?.diagnosis?.candidates.map((candidate) => candidate.kind)).toContain('replan')
  })

  it('refuses to run a destructive step until it is approved', async () => {
    const w = await workspace()
    const added = await addGoal(
      w.db,
      [
        {
          intent: 'restore the app',
          action: { command: 'restore', args: ['--dsn', DSN, '--input', '/tmp/dump.sql'] },
        },
      ],
      { constraints: { allowDestructive: true } },
    )
    const executor = successExecutor()

    const result = await goal(['run', '--db', w.db, '--goal', added.goalId], { executor })
    expect(result.code).toBe(1)
    const payload = parse<RunPayload>(result.stdout)
    expect(payload.diagnosis?.signature).toBe('approval:required')
    // Nothing was dispatched, so the executor never saw a command.
    expect(executor.calls).toHaveLength(0)

    const steps = await storedSteps(w.db, added.goalId)
    expect(steps[0]?.state).toBe('ready')
    expect(steps[0]?.lastErrorClass).toBe('manual')
  })

  it('dispatches --yes and the control db once the step is approved', async () => {
    const w = await workspace()
    const dump = join(w.dir, 'dump.sql')
    await writeFile(dump, 'dump')
    const added = await addGoal(
      w.db,
      [
        {
          intent: 'restore the app',
          action: { command: 'restore', args: ['--dsn', DSN, '--input', dump] },
        },
      ],
      { constraints: { allowDestructive: true } },
    )
    const stepId = added.steps?.[0]?.stepId as string

    const approved = await goal([
      'approve-step',
      '--db',
      w.db,
      '--step',
      stepId,
      '--approver',
      'os:alice',
      '--reason',
      'approved for the drill',
    ])
    expect(approved.code).toBe(0)
    const approval = parse<{ stepId: string; approvedBy: string; approvedAt: string }>(
      approved.stdout,
    )
    expect(approval.stepId).toBe(stepId)
    expect(approval.approvedBy).toBe('os:alice')

    const executor = successExecutor()
    const result = await goal(['run', '--db', w.db, '--goal', added.goalId], { executor })
    expect(result.dispatched).toHaveLength(1)
    const argv = result.dispatched[0] as string[]
    expect(argv[0]).toBe('restore')
    expect(argv).toContain('--yes')
    expect(argv).toContain('--db')
    expect(argv[argv.indexOf('--db') + 1]).toBe(w.db)
    // The dispatch reached the CLI, which probed through the injected executor.
    expect(executor.calls.length).toBeGreaterThan(0)
    // The destructive gate still refuses an unregistered target, so the run fails.
    expect(result.code).toBe(1)
  })

  it('blocks a dependent step once its dependency fails', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [
      { intent: 'inspect the primary', action: { command: 'inspect', args: ['--dsn', DSN] } },
      {
        intent: 'inspect after the first',
        action: { command: 'inspect', args: ['--dsn', DSN] },
        dependsOn: [1],
      },
    ])
    const failing: DispatchHandler = async (_argv, _stdout, stderr) => {
      stderr('psql: error: database "app" does not exist\n')
      return 1
    }

    const first = await goal(['run', '--db', w.db, '--goal', added.goalId], { dispatch: failing })
    expect(first.code).toBe(1)
    expect((await storedSteps(w.db, added.goalId))[0]?.state).toBe('failed')

    // The blocked sweep happens on the next scheduler pass: the failed step can
    // never succeed, so its dependent is blocked and the goal is failed.
    const second = await goal(['run', '--db', w.db, '--goal', added.goalId], { dispatch: failing })
    expect(second.code).toBe(1)
    const payload = parse<RunPayload>(second.stdout)
    expect(payload.next).toMatchObject({ kind: 'done', failed: true })

    const steps = await storedSteps(w.db, added.goalId)
    expect(steps.map((step) => step.state)).toEqual(['failed', 'blocked'])
    expect((await storedGoal(w.db, added.goalId))?.state).toBe('failed')
  })
})

describe('bkagent goal remediate', () => {
  it('replans a permanently failed step and then runs it', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [INSPECT_STEP])
    const stepId = added.steps?.[0]?.stepId as string

    const failed = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      dispatch: async (_argv, _stdout, stderr) => {
        stderr('psql: error: database "app" does not exist\n')
        return 1
      },
    })
    expect(failed.code).toBe(1)

    const remediated = await goal([
      'remediate',
      '--db',
      w.db,
      '--step',
      stepId,
      '--kind',
      'replan',
      '--action-json',
      JSON.stringify({
        command: 'inspect',
        args: ['--dsn', 'postgres://backup@127.0.0.1:55416/app2'],
      }),
      '--reason',
      'the database name was wrong',
    ])
    expect(remediated.code).toBe(0)
    const decision = parse<{ kind: string; stepState: string; goalState: string; action: unknown }>(
      remediated.stdout,
    )
    expect(decision.kind).toBe('replan')
    expect(decision.stepState).toBe('ready')
    expect(decision.goalState).toBe('planned')

    const replanned = await storedSteps(w.db, added.goalId)
    expect(replanned[0]?.state).toBe('ready')
    expect(replanned[0]?.action.args).toContain('postgres://backup@127.0.0.1:55416/app2')

    const rerun = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      dispatch: async () => 0,
    })
    expect(rerun.code).toBe(0)
    expect((await storedGoal(w.db, added.goalId))?.state).toBe('succeeded')
    expect((await storedSteps(w.db, added.goalId))[0]?.state).toBe('succeeded')
  })

  it('refuses a retry after a manual failure', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [INSPECT_STEP])
    const stepId = added.steps?.[0]?.stepId as string

    const failed = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      dispatch: async (_argv, _stdout, stderr) => {
        stderr('psql: error: password authentication failed for user "backup"\n')
        return 1
      },
    })
    expect(failed.code).toBe(1)
    expect(parse<RunPayload>(failed.stdout).diagnosis?.signature).toBe('auth:password')

    const refused = await goal([
      'remediate',
      '--db',
      w.db,
      '--step',
      stepId,
      '--kind',
      'retry',
    ])
    expect(refused.code).toBe(4)
    const payload = parse<{ refused: string }>(refused.stdout)
    expect(payload.refused).toContain('retry')
    expect((await storedSteps(w.db, added.goalId))[0]?.state).toBe('failed')
  })
})

describe('bkagent goal approve-step', () => {
  it('refuses to approve a non-destructive step', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [INSPECT_STEP], { constraints: { allowDestructive: true } })
    const stepId = added.steps?.[0]?.stepId as string

    const result = await goal([
      'approve-step',
      '--db',
      w.db,
      '--step',
      stepId,
      '--approver',
      'os:alice',
    ])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('not destructive')
    expect((await storedSteps(w.db, added.goalId))[0]?.approvedBy).toBeNull()
  })
})

describe('bkagent goal next', () => {
  it('is read-only across repeated calls', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [
      { intent: 'inspect once', action: { command: 'inspect', args: ['--dsn', DSN] } },
      {
        intent: 'inspect twice',
        action: { command: 'inspect', args: ['--dsn', DSN] },
        dependsOn: [1],
      },
    ])
    const stepId = added.steps?.[0]?.stepId as string

    const before = {
      goal: await storedGoal(w.db, added.goalId),
      steps: await storedSteps(w.db, added.goalId),
    }

    const first = await goal(['next', '--db', w.db, '--goal', added.goalId])
    const second = await goal(['next', '--db', w.db, '--goal', added.goalId])
    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    expect(first.stdout).toBe(second.stdout)
    const payload = parse<{ state: string; next: { kind: string; stepId?: string } }>(first.stdout)
    expect(payload.state).toBe('planned')
    expect(payload.next).toEqual({ kind: 'run', stepId })

    const after = {
      goal: await storedGoal(w.db, added.goalId),
      steps: await storedSteps(w.db, added.goalId),
    }
    expect(after.goal?.state).toBe(before.goal?.state)
    expect(after.steps.map((step) => [step.state, step.attempts])).toEqual(
      before.steps.map((step) => [step.state, step.attempts]),
    )
    expect(await withRepo(w.db, async (repo) => repo.stepAttempts.listByStep(asGoalStepId(stepId))))
      .toEqual([])
  })
})

describe('bkagent memory search', () => {
  it('returns the recorded outcome with a redacted action', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [INSPECT_STEP])
    const run = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      executor: successExecutor(),
    })
    expect(run.code).toBe(0)

    const result = await memory(['search', '--db', w.db, '--target', 'app-1'])
    expect(result.code).toBe(0)
    const payload = parse<{
      query: { targetId?: string }
      hits: {
        memoryId: string
        targetId: string
        signature: string
        action: { command: string; args: string[] }
        outcome: { command: string; state: string; exitCode: number | null; error: string | null }
        success: boolean
        createdAt: string
        score: number
      }[]
    }>(result.stdout)

    expect(payload.query.targetId).toBe('app-1')
    expect(payload.hits).toHaveLength(1)
    const hit = payload.hits[0]
    expect(hit?.signature).toBe('ok')
    expect(hit?.success).toBe(true)
    expect(hit?.outcome.state).toBe('succeeded')
    expect(hit?.action.args).toContain(DSN)
    expect(result.stdout).not.toContain('s3cret')
  })

  it('keeps the env credential out of goal_steps and memory_entries', async () => {
    const w = await workspace()
    const added = await addGoal(w.db, [
      {
        intent: 'inspect with a credential from the environment',
        action: { command: 'inspect', args: ['--dsn', 'postgres://u@h/db'] },
      },
    ])
    // The password lives only in the environment; an action may not carry one.
    const env = { BKAGENT_DSN: 'postgres://u:s3cret@h/db' }
    const run = await goal(['run', '--db', w.db, '--goal', added.goalId], {
      env,
      dispatch: async (_argv, _stdout, stderr) => {
        stderr('psql: error: could not connect to server: Connection refused\n')
        return 3
      },
    })
    expect(run.code).toBe(1)

    const result = await memory(['search', '--db', w.db, '--signature', 'connect:refused'], env)
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('s3cret')
    const payload = parse<{ hits: { action: { args: string[] }; signature: string }[] }>(
      result.stdout,
    )
    expect(payload.hits.length).toBeGreaterThan(0)
    expect(payload.hits[0]?.action.args).toContain('postgres://u@h/db')

    // The credential was never persisted, in either table.
    const stored = await withRepo(w.db, async (repo) => ({
      steps: JSON.stringify(await repo.goalSteps.listByGoal(asGoalId(added.goalId))),
      memory: JSON.stringify(await repo.memory.list({})),
    }))
    expect(stored.steps).not.toContain('s3cret')
    expect(stored.memory).not.toContain('s3cret')
    expect(stored.steps).toContain('postgres://u@h/db')
  })
})
