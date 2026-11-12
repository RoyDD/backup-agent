import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asTargetId, type AssetDescriptor, type Repository } from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'
import { FakeExecutor } from '@backup-agent/core/testkit'

import { runCli } from '../src/cli'
import { DESTRUCTIVE_PLAN_COMMANDS } from '../src/destructive-gate'

const DSN = 'postgres://backup:secret@127.0.0.1:55416/app'
const SYSTEM_IDENTIFIER = '7421000000000000001'
const BASIC = JSON.stringify({
  version: 'PostgreSQL 16.15',
  serverVersionNum: 160015,
  currentUser: 'backup',
  currentDatabase: 'app',
  databaseOid: '16384',
  inRecovery: false,
  walLevel: 'replica',
  archiveMode: 'on',
  databases: ['app'],
})

interface Workspace {
  readonly dir: string
  readonly db: string
  readonly input: string
  readonly dataDir: string
  readonly logFile: string
  readonly config: string
}

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'bkagent-gate-'))
  workspaces.push(dir)
  const input = join(dir, 'dump.bin')
  await writeFile(input, 'dump')
  return {
    dir,
    db: join(dir, 'control.db'),
    input,
    dataDir: join(dir, 'data'),
    logFile: join(dir, 'recovery.log'),
    config: join(dir, 'pgbackrest.conf'),
  }
}

function capture(): {
  stdout: string[]
  stderr: string[]
  write: (text: string) => void
  writeError: (text: string) => void
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, write: (text) => stdout.push(text), writeError: (text) => stderr.push(text) }
}

/** Answers probe queries and treats every execution step as successful. */
function probeExecutor(systemIdentifier: string | null = SYSTEM_IDENTIFIER): FakeExecutor {
  return new FakeExecutor({
    defaultHandler: (cmd) => {
      const line = cmd.join(' ')
      if (line.includes('json_build_object')) return { stdout: BASIC }
      if (line.includes('pg_control_system')) {
        return systemIdentifier === null
          ? { stdout: '', stderr: 'ERROR: must be superuser' }
          : { stdout: systemIdentifier }
      }
      return {}
    },
  })
}

/**
 * Returns one system identifier per `pg_control_system()` probe. Used to
 * simulate the target changing or disappearing between authorization and
 * execution.
 */
function sequencedProbeExecutor(identities: readonly (string | null)[]): {
  executor: FakeExecutor
  probes: () => number
} {
  let index = 0
  const executor = new FakeExecutor({
    defaultHandler: (cmd) => {
      const line = cmd.join(' ')
      if (line.includes('json_build_object')) return { stdout: BASIC }
      if (line.includes('pg_control_system')) {
        const value = identities[index]
        index += 1
        if (value === undefined) return { stdout: '' }
        return value === null
          ? { stdout: '', stderr: 'ERROR: must be superuser' }
          : { stdout: value }
      }
      return {}
    },
  })
  return { executor, probes: () => index }
}

function asset(targetId: string, overrides: Partial<AssetDescriptor> = {}): AssetDescriptor {
  return {
    targetId: asTargetId(targetId),
    engine: 'postgres',
    environment: 'development',
    owner: 'dba',
    criticality: 'medium',
    dataClassification: 'internal',
    rpoMinutes: 60,
    rtoMinutes: 120,
    protected: false,
    ...overrides,
  }
}

async function withRepo<T>(db: string, fn: (repo: Repository) => Promise<T>): Promise<T> {
  const repo = await createSqliteRepository({ filename: db })
  await repo.migrate()
  try {
    return await fn(repo)
  } finally {
    await repo.close()
  }
}

async function registerAsset(db: string, descriptor: AssetDescriptor): Promise<void> {
  await withRepo(db, async (repo) => repo.assets.upsert(descriptor))
}

async function recordDecision(
  db: string,
  targetId: string,
  digest: string,
  approver: string,
  decision: 'approve' | 'reject' = 'approve',
  createdAt = new Date().toISOString(),
): Promise<void> {
  await withRepo(db, async (repo) =>
    repo.approvals.record({
      id: `apr_${approver}_${createdAt}_${decision}`,
      targetId: asTargetId(targetId),
      configDigest: digest,
      approver,
      decision,
      reason: null,
      createdAt,
    }),
  )
}

function destructiveCalls(executor: FakeExecutor, binary: string): number {
  return executor.calls.filter((call) => call.argv[0] === binary).length
}

interface DestructiveCase {
  readonly name: (typeof DESTRUCTIVE_PLAN_COMMANDS)[number]
  readonly args: (w: Workspace) => string[]
  readonly targetId: (w: Workspace) => string
  /** Binary whose invocation proves the plan executed. */
  readonly binary: string
}

const CASES: readonly DestructiveCase[] = [
  {
    name: 'restore',
    args: (w) => [
      'restore',
      '--dsn',
      DSN,
      '--input',
      w.input,
      '--format',
      'custom',
      '--clean',
    ],
    targetId: () => '127.0.0.1:55416/app',
    binary: 'pg_restore',
  },
  {
    name: 'pitr',
    args: (w) => [
      'pitr',
      '--dsn',
      DSN,
      '--data-dir',
      w.dataDir,
      '--port',
      '55416',
      '--log',
      w.logFile,
      '--restore-command',
      'wal-g wal-fetch %f %p',
      '--target-time',
      '2026-01-01T00:00:00Z',
    ],
    targetId: (w) => `pitr:${w.dataDir}`,
    binary: 'pg_ctl',
  },
  {
    name: 'pgbackrest-restore',
    args: (w) => [
      'pgbackrest-restore',
      '--config',
      w.config,
      '--stanza',
      'main',
      '--data-dir',
      w.dataDir,
      '--dsn',
      DSN,
    ],
    targetId: () => 'pgbackrest:main',
    binary: 'pgbackrest',
  },
  {
    name: 'pgbackrest-expire',
    args: (w) => ['pgbackrest-expire', '--config', w.config, '--stanza', 'main', '--dsn', DSN],
    targetId: () => 'pgbackrest:main',
    binary: 'pgbackrest',
  },
  {
    name: 'walg-restore',
    args: (w) => ['walg-restore', '--data-dir', w.dataDir, '--dsn', DSN],
    targetId: (w) => `walg:${w.dataDir}`,
    binary: 'wal-g',
  },
  {
    name: 'walg-prune',
    args: () => ['walg-prune', '--retain-full', '2', '--dsn', DSN],
    targetId: () => 'walg:repository',
    binary: 'wal-g',
  },
]

describe('destructive plan gate (all command paths)', () => {
  it('covers every command registered as destructive', () => {
    expect(CASES.map((entry) => entry.name).sort()).toEqual([...DESTRUCTIVE_PLAN_COMMANDS].sort())
  })

  for (const entry of CASES) {
    it(`${entry.name}: refuses without --yes and never invokes the plan`, async () => {
      const w = await workspace()
      const executor = probeExecutor()
      const out = capture()

      const code = await runCli(entry.args(w), {
        executor,
        stdout: out.write,
        stderr: out.writeError,
        env: { USER: 'roy' },
      })

      expect(code).toBe(2)
      expect(out.stderr.join('')).toContain('re-run with --yes')
      expect(destructiveCalls(executor, entry.binary)).toBe(0)
    })

    it(`${entry.name}: refuses without a registered asset and reports targetId`, async () => {
      const w = await workspace()
      const executor = probeExecutor()
      const out = capture()
      const targetId = entry.targetId(w)

      const code = await runCli([...entry.args(w), '--yes', '--db', w.db], {
        executor,
        stdout: out.write,
        stderr: out.writeError,
        env: { USER: 'roy' },
      })

      const stderr = out.stderr.join('')
      expect(code).toBe(2)
      expect(stderr).toContain('no asset registered')
      expect(stderr).toContain(targetId)
      expect(stderr).toContain('asset-set')
      expect(destructiveCalls(executor, entry.binary)).toBe(0)
    })
  }

  it('refuses when the live probe cannot prove target identity', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('pgbackrest:main'))
    const executor = probeExecutor(null)
    const out = capture()

    const code = await runCli(
      ['pgbackrest-expire', '--config', w.config, '--stanza', 'main', '--yes', '--db', w.db],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(4)
    expect(out.stderr.join('')).toContain('cannot prove target identity')
    expect(destructiveCalls(executor, 'pgbackrest')).toBe(0)
  })

  it('gates a plain SQL restore even without --clean because input may contain destructive SQL', async () => {
    const w = await workspace()
    await writeFile(w.input, 'DROP TABLE users;\n')
    const executor = probeExecutor()
    const out = capture()

    const code = await runCli(
      ['restore', '--dsn', DSN, '--input', w.input, '--format', 'plain', '--db', w.db],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(2)
    expect(out.stderr.join('')).toContain('re-run with --yes')
    // The probe runs before the gate and issues read-only `psql -c` queries; no
    // restore plan (`psql ... --file=`) may have been dispatched.
    expect(
      executor.calls.filter(
        (call) => call.argv[0] === 'psql' && call.argv.some((arg) => arg.startsWith('--file=')),
      ),
    ).toHaveLength(0)
  })
})

describe('destructive plan gate (authorization)', () => {
  it('allows a registered non-production asset after --yes', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('127.0.0.1:55416/app'))
    const executor = probeExecutor()
    const out = capture()

    const code = await runCli(
      ['restore', '--dsn', DSN, '--input', w.input, '--format', 'custom', '--clean', '--yes', '--db', w.db],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(0)
    expect(destructiveCalls(executor, 'pg_restore')).toBe(1)
    expect(executor.calls.find((call) => call.argv[0] === 'pg_restore')?.argv).toContain('--clean')
  })

  it('requires two current approvals for a protected production asset', async () => {
    const w = await workspace()
    await registerAsset(
      w.db,
      asset('127.0.0.1:55416/app', { environment: 'production', protected: true }),
    )
    const executor = probeExecutor()
    const argv = ['restore', '--dsn', DSN, '--input', w.input, '--format', 'custom', '--clean', '--yes', '--db', w.db]

    const first = capture()
    expect(
      await runCli(argv, {
        executor,
        stdout: first.write,
        stderr: first.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(2)
    const denied = first.stderr.join('')
    expect(denied).toContain('requires 2 distinct approvals')
    const digest = /digest: ([0-9a-f]+)/.exec(denied)?.[1]
    expect(digest).toBeTruthy()
    expect(destructiveCalls(executor, 'pg_restore')).toBe(0)

    await recordDecision(w.db, '127.0.0.1:55416/app', digest as string, 'alice')
    await recordDecision(w.db, '127.0.0.1:55416/app', digest as string, 'bob')

    const second = capture()
    expect(
      await runCli(argv, {
        executor,
        stdout: second.write,
        stderr: second.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(0)
    expect(destructiveCalls(executor, 'pg_restore')).toBe(1)
  })

  it('requires two approvals on a production asset even when it is not protected', async () => {
    const w = await workspace()
    await registerAsset(
      w.db,
      asset('127.0.0.1:55416/app', { environment: 'production', protected: false }),
    )
    const executor = probeExecutor()
    const argv = [
      'restore',
      '--dsn',
      DSN,
      '--input',
      w.input,
      '--format',
      'custom',
      '--clean',
      '--yes',
      '--db',
      w.db,
    ]

    const first = capture()
    expect(
      await runCli(argv, {
        executor,
        stdout: first.write,
        stderr: first.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(2)
    const denied = first.stderr.join('')
    expect(denied).toContain('production-destructive')
    expect(denied).toContain('requires 2 distinct approvals')
    expect(destructiveCalls(executor, 'pg_restore')).toBe(0)

    const digest = /digest: ([0-9a-f]+)/.exec(denied)?.[1] as string
    await recordDecision(w.db, '127.0.0.1:55416/app', digest, 'alice')
    await recordDecision(w.db, '127.0.0.1:55416/app', digest, 'bob')

    const second = capture()
    expect(
      await runCli(argv, {
        executor,
        stdout: second.write,
        stderr: second.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(0)
    expect(destructiveCalls(executor, 'pg_restore')).toBe(1)
  })

  it('ignores requester self-approval and rejects a superseded approval', async () => {
    const w = await workspace()
    await registerAsset(
      w.db,
      asset('pgbackrest:main', { environment: 'production', protected: true }),
    )
    const executor = probeExecutor()
    const argv = [
      'pgbackrest-expire',
      '--config',
      w.config,
      '--stanza',
      'main',
      '--dsn',
      DSN,
      '--yes',
      '--db',
      w.db,
    ]

    const first = capture()
    expect(
      await runCli(argv, {
        executor,
        stdout: first.write,
        stderr: first.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(2)
    const digest = /digest: ([0-9a-f]+)/.exec(first.stderr.join(''))?.[1] as string

    // alice approves then reverses; the requester approves; bob approves once.
    await recordDecision(w.db, 'pgbackrest:main', digest, 'alice')
    await recordDecision(w.db, 'pgbackrest:main', digest, 'alice', 'reject')
    await recordDecision(w.db, 'pgbackrest:main', digest, 'os:roy')
    await recordDecision(w.db, 'pgbackrest:main', digest, 'bob')

    const second = capture()
    expect(
      await runCli(argv, {
        executor,
        stdout: second.write,
        stderr: second.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(2)
    const denied = second.stderr.join('')
    expect(denied).toContain('have 1')
    expect(denied).toContain('ignored self-approval')
    expect(destructiveCalls(executor, 'pgbackrest')).toBe(0)

    await recordDecision(w.db, 'pgbackrest:main', digest, 'carol')
    const third = capture()
    expect(
      await runCli(argv, {
        executor,
        stdout: third.write,
        stderr: third.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(0)
    expect(destructiveCalls(executor, 'pgbackrest')).toBe(1)
  })

  it('resolves BKAGENT_DB when --db is omitted and prefers --db over it', async () => {
    const w = await workspace()
    const envDb = join(w.dir, 'env.db')
    await registerAsset(envDb, asset('127.0.0.1:55416/app'))
    const executor = probeExecutor()
    const args = ['restore', '--dsn', DSN, '--input', w.input, '--format', 'custom', '--clean', '--yes']

    const envRun = capture()
    expect(
      await runCli(args, {
        executor,
        stdout: envRun.write,
        stderr: envRun.writeError,
        env: { USER: 'roy', BKAGENT_DB: envDb },
      }),
    ).toBe(0)

    const emptyDb = join(w.dir, 'empty.db')
    const flagRun = capture()
    expect(
      await runCli([...args, '--db', envDb], {
        executor,
        stdout: flagRun.write,
        stderr: flagRun.writeError,
        env: { USER: 'roy', BKAGENT_DB: emptyDb },
      }),
    ).toBe(0)
    expect(destructiveCalls(executor, 'pg_restore')).toBe(2)
  })
})

describe('destructive plan gate (identity drift before execution)', () => {
  const OTHER_IDENTIFIER = '7421000000000000002'
  const restoreArgv = (w: Workspace): string[] => [
    'restore',
    '--dsn',
    DSN,
    '--input',
    w.input,
    '--format',
    'custom',
    '--clean',
    '--yes',
    '--db',
    w.db,
  ]

  it('logical restore aborts when the refresh probe loses the identity', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('127.0.0.1:55416/app'))
    const sequence = sequencedProbeExecutor([SYSTEM_IDENTIFIER, null])
    const out = capture()

    const code = await runCli(restoreArgv(w), {
      executor: sequence.executor,
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })

    expect(code).toBe(4)
    expect(out.stderr.join('')).toContain('cannot prove target identity')
    expect(sequence.probes()).toBe(2)
    expect(destructiveCalls(sequence.executor, 'pg_restore')).toBe(0)
  })

  it('logical restore aborts when identity changes after the plan was prepared', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('127.0.0.1:55416/app'))
    const sequence = sequencedProbeExecutor([SYSTEM_IDENTIFIER, SYSTEM_IDENTIFIER, OTHER_IDENTIFIER])
    const out = capture()

    const code = await runCli(restoreArgv(w), {
      executor: sequence.executor,
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })

    expect(code).toBe(4)
    expect(out.stderr.join('')).toContain('cannot prove target identity')
    expect(sequence.probes()).toBe(3)
    expect(destructiveCalls(sequence.executor, 'pg_restore')).toBe(0)
  })

  it('logical restore aborts when identity disappears before the prepared plan runs', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('127.0.0.1:55416/app'))
    const sequence = sequencedProbeExecutor([SYSTEM_IDENTIFIER, SYSTEM_IDENTIFIER, null])
    const out = capture()

    const code = await runCli(restoreArgv(w), {
      executor: sequence.executor,
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })

    expect(code).toBe(4)
    expect(out.stderr.join('')).toContain('cannot prove target identity')
    expect(sequence.probes()).toBe(3)
    expect(destructiveCalls(sequence.executor, 'pg_restore')).toBe(0)
  })

  it('pgbackrest-expire aborts when identity changes between gate and execution', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('pgbackrest:main'))
    const sequence = sequencedProbeExecutor([SYSTEM_IDENTIFIER, OTHER_IDENTIFIER])
    const out = capture()

    const code = await runCli(
      ['pgbackrest-expire', '--config', w.config, '--stanza', 'main', '--dsn', DSN, '--yes', '--db', w.db],
      {
        executor: sequence.executor,
        stdout: out.write,
        stderr: out.writeError,
        env: { USER: 'roy' },
      },
    )

    expect(code).toBe(4)
    expect(out.stderr.join('')).toContain('cannot prove target identity')
    expect(sequence.probes()).toBe(2)
    expect(destructiveCalls(sequence.executor, 'pgbackrest')).toBe(0)
  })

  it('pgbackrest-expire aborts when identity disappears between gate and execution', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('pgbackrest:main'))
    const sequence = sequencedProbeExecutor([SYSTEM_IDENTIFIER, null])
    const out = capture()

    const code = await runCli(
      ['pgbackrest-expire', '--config', w.config, '--stanza', 'main', '--dsn', DSN, '--yes', '--db', w.db],
      {
        executor: sequence.executor,
        stdout: out.write,
        stderr: out.writeError,
        env: { USER: 'roy' },
      },
    )

    expect(code).toBe(4)
    expect(out.stderr.join('')).toContain('cannot prove target identity')
    expect(sequence.probes()).toBe(2)
    expect(destructiveCalls(sequence.executor, 'pgbackrest')).toBe(0)
  })
})

describe('destructive plan gate (execution wiring)', () => {
  it('executes pitr once the asset and --yes are present', async () => {
    const w = await workspace()
    await mkdir(w.dataDir, { recursive: true })
    await registerAsset(w.db, asset(`pitr:${w.dataDir}`))
    const executor = probeExecutor()
    const out = capture()

    const code = await runCli(
      [
        'pitr',
        '--dsn',
        DSN,
        '--data-dir',
        w.dataDir,
        '--port',
        '55416',
        '--log',
        w.logFile,
        '--restore-command',
        'wal-g wal-fetch %f %p',
        '--target-time',
        '2026-01-01T00:00:00Z',
        '--yes',
        '--db',
        w.db,
      ],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(0)
    expect(destructiveCalls(executor, 'pg_ctl')).toBeGreaterThan(0)
  })

  it('executes pgbackrest-restore once the asset and --yes are present', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('pgbackrest:main'))
    const executor = probeExecutor()
    const out = capture()

    const code = await runCli(
      [
        'pgbackrest-restore',
        '--config',
        w.config,
        '--stanza',
        'main',
        '--data-dir',
        w.dataDir,
        '--dsn',
        DSN,
        '--yes',
        '--db',
        w.db,
      ],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(0)
    expect(destructiveCalls(executor, 'pgbackrest')).toBe(1)
  })

  it('executes pgbackrest-expire once the asset and --yes are present', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('pgbackrest:main'))
    const executor = probeExecutor()
    const out = capture()

    const code = await runCli(
      ['pgbackrest-expire', '--config', w.config, '--stanza', 'main', '--dsn', DSN, '--yes', '--db', w.db],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(0)
    expect(destructiveCalls(executor, 'pgbackrest')).toBe(1)
  })

  it('executes walg-restore once the asset and --yes are present', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset(`walg:${w.dataDir}`))
    const executor = probeExecutor()
    const out = capture()

    const code = await runCli(
      ['walg-restore', '--data-dir', w.dataDir, '--dsn', DSN, '--yes', '--db', w.db],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(0)
    expect(destructiveCalls(executor, 'wal-g')).toBe(1)
  })

  it('executes walg-prune once the asset and --yes are present', async () => {
    const w = await workspace()
    await registerAsset(w.db, asset('walg:repository'))
    const executor = probeExecutor()
    const out = capture()

    const code = await runCli(
      ['walg-prune', '--retain-full', '2', '--dsn', DSN, '--yes', '--db', w.db],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(0)
    expect(destructiveCalls(executor, 'wal-g')).toBe(1)
  })
})
