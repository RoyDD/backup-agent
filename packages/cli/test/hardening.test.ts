import { existsSync, utimesSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_RETRY_POLICY,
  asArtifactId,
  fsArtifactSink,
  asMandateId,
  asPlanId,
  asTargetId,
  asTicketId,
  assetProtectionDigest,
  newId,
  type AssetDescriptor,
  type InstanceInfo,
  type Plan,
  type Repository,
  type RiskLevel,
} from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'
import { FakeExecutor } from '@backup-agent/core/testkit'

import { runCli } from '../src/cli'
import { authorizeDestructivePlan } from '../src/destructive-gate'
import { availableBytesAt, executePlan } from '../src/execute-plan'

const DSN = 'postgres://backup:secret@127.0.0.1:55416/app'
const TARGET = '127.0.0.1:55416/app'
const RESTORE_TARGET = '127.0.0.1:55416/app_restored'
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

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace(): Promise<{ dir: string; db: string; input: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bkagent-hardening-'))
  dirs.push(dir)
  const input = join(dir, 'dump.bin')
  await writeFile(input, 'dump-contents')
  return { dir, db: join(dir, 'control.db'), input }
}

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

/** Maps a capture buffer onto the CLI's dependency shape. */
function io(out: ReturnType<typeof capture>): {
  stdout: (text: string) => void
  stderr: (text: string) => void
} {
  return { stdout: out.write, stderr: out.writeError }
}

async function withRepo<T>(file: string, fn: (repo: Repository) => Promise<T>): Promise<T> {
  const repo = await createSqliteRepository({ filename: file })
  await repo.migrate()
  try {
    return await fn(repo)
  } finally {
    await repo.close()
  }
}

function instanceInfo(): InstanceInfo {
  return {
    version: 'PostgreSQL 16.15',
    serverVersionNum: 160015,
    currentUser: 'backup',
    currentDatabase: 'app',
    databaseOid: '16384',
    inRecovery: false,
    systemIdentifier: SYSTEM_IDENTIFIER,
    walLevel: 'replica',
    archiveMode: 'on',
    databases: ['app'],
    executionSite: 'fake',
    warnings: [],
  }
}

function planWithRisk(risk: RiskLevel): Plan {
  const now = Date.now()
  return {
    planId: asPlanId(newId('pln')),
    ticketId: asTicketId(newId('tkt')),
    mandateId: asMandateId(newId('mnd')),
    engine: 'postgres',
    provider: 'native-logical',
    targetId: asTargetId(TARGET),
    fingerprint: {
      systemIdentifier: SYSTEM_IDENTIFIER,
      configDigest: 'digest-hardening',
      targetOid: '16384',
      createdAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 3_600_000).toISOString(),
    },
    steps: [
      {
        stepId: 'restore',
        kind: 'exec',
        dependsOn: [],
        argv: ['pg_restore'],
        preconditions: [],
        postconditions: [],
        retry: DEFAULT_RETRY_POLICY,
        checkpoint: 'after',
        idempotencyKey: 'restore',
      },
    ],
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    risk,
  }
}

function productionAsset(overrides: Partial<AssetDescriptor> = {}): AssetDescriptor {
  return {
    targetId: asTargetId(TARGET),
    engine: 'postgres',
    environment: 'production',
    owner: 'dba',
    criticality: 'critical',
    dataClassification: 'internal',
    rpoMinutes: 60,
    rtoMinutes: 240,
    protected: false,
    ...overrides,
  }
}

/** Answers the probe queries; every other command succeeds. */
function probeExecutor(): FakeExecutor {
  return new FakeExecutor({
    defaultHandler: (cmd) => {
      const line = cmd.join(' ')
      if (line.includes('json_build_object')) return { stdout: BASIC }
      if (line.includes('pg_control_system')) return { stdout: SYSTEM_IDENTIFIER }
      return {}
    },
  })
}

async function pendingOutbox(db: string): Promise<Record<string, unknown>[]> {
  return await withRepo(db, async (repo) => {
    const records = await repo.outbox.claim({
      now: new Date().toISOString(),
      limit: 50,
      leaseMs: 60_000,
    })
    return records.map((record) => record.payload as Record<string, unknown>)
  })
}

describe('destructive gate: plan label cannot skip authorization', () => {
  it('refuses a sub-destructive plan and records the refusal', async () => {
    const { db } = await workspace()
    await withRepo(db, async () => undefined)

    const result = await authorizeDestructivePlan({
      plan: planWithRisk('read-only'),
      instance: instanceInfo(),
      controlDb: db,
      confirmed: true,
      requester: 'os:alice',
      osPrincipal: 'os:alice',
    })

    expect(result.kind).toBe('denied')
    if (result.kind === 'denied') expect(result.reason).toBe('risk-understated')
    const events = await pendingOutbox(db)
    expect(
      events.some(
        (event) => event['event'] === 'authorization.denied' && event['reason'] === 'risk-understated',
      ),
    ).toBe(true)
  })

  it('records an audit event when approvals are insufficient', async () => {
    const { dir, db, input } = await workspace()
    await withRepo(db, async (repo) => {
      await repo.assets.upsert(productionAsset())
      // The logical restore plan targets the *database being written*, so both
      // identities are registered to keep the test about approvals.
      await repo.assets.upsert(
        productionAsset({ targetId: asTargetId(RESTORE_TARGET) }),
      )
    })

    const out = capture()
    const code = await runCli(
      ['restore', '--dsn', DSN, '--input', input, '--database', 'app_restored', '--yes', '--db', db],
      { executor: probeExecutor(), env: { ...process.env, USER: 'alice' }, ...io(out) },
    )

    expect(code).toBe(2)
    expect(out.stderr.join('')).toContain('distinct')
    const events = await pendingOutbox(db)
    expect(events.some((event) => event['event'] === 'authorization.denied')).toBe(true)
    expect(dir).toBeTruthy()
  })
})

describe('approvals carry the environment identity', () => {
  it('does not accept two labels recorded by one OS user', async () => {
    const { db, input } = await workspace()
    await withRepo(db, async (repo) => {
      await repo.assets.upsert(productionAsset())
      // The logical restore plan targets the *database being written*, so both
      // identities are registered to keep the test about approvals.
      await repo.assets.upsert(
        productionAsset({ targetId: asTargetId(RESTORE_TARGET) }),
      )
    })
    const env = { ...process.env, USER: 'alice' }

    const first = capture()
    await runCli(
      ['restore', '--dsn', DSN, '--input', input, '--database', 'app_restored', '--yes', '--db', db],
      { executor: probeExecutor(), env, ...io(first) },
    )
    const digest = /digest: ([0-9a-f]{64})/.exec(first.stderr.join(''))?.[1]
    expect(digest).toBeDefined()

    for (const approver of ['alice', 'bob']) {
      const approved = await runCli(
        ['approve', '--db', db, '--target', RESTORE_TARGET, '--digest', digest as string, '--approver', approver],
        { env, ...io(capture()) },
      )
      expect(approved).toBe(0)
    }

    const second = capture()
    const code = await runCli(
      ['restore', '--dsn', DSN, '--input', input, '--database', 'app_restored', '--yes', '--db', db],
      { executor: probeExecutor(), env, ...io(second) },
    )
    expect(code).toBe(2)
    // Both labels belong to the requester's OS identity, so neither counts.
    expect(second.stderr.join('')).toContain('have 0')

    const approvals = await withRepo(db, (repo) =>
      repo.approvals.listFor(
        asTargetId(RESTORE_TARGET),
        digest as string,
        new Date(Date.now() - 3_600_000).toISOString(),
      ),
    )
    expect(approvals.map((approval) => approval.approverOs)).toEqual(['os:alice', 'os:alice'])

    // Two other humans (as their own sessions would record them) open the gate.
    await withRepo(db, async (repo) => {
      for (const approver of ['os:bob', 'os:carol']) {
        await repo.approvals.record({
          id: newId('apr'),
          targetId: asTargetId(RESTORE_TARGET),
          configDigest: digest as string,
          approver,
          approverOs: approver,
          decision: 'approve',
          reason: null,
          createdAt: new Date().toISOString(),
        })
      }
    })

    const third = capture()
    const allowed = await runCli(
      ['restore', '--dsn', DSN, '--input', input, '--database', 'app_restored', '--yes', '--db', db],
      { executor: probeExecutor(), env, ...io(third) },
    )
    expect(allowed).toBe(0)
  })
})

describe('asset-set protection gate', () => {
  it('requires --yes and two approvals to weaken an asset', async () => {
    const { db } = await workspace()
    const env = { ...process.env, USER: 'alice' }
    const base = [
      'asset-set',
      '--db',
      db,
      '--target',
      TARGET,
      '--engine',
      'postgres',
      '--owner',
      'dba',
      '--criticality',
      'critical',
      '--data-classification',
      'internal',
      '--rpo-minutes',
      '60',
      '--rto-minutes',
      '240',
    ]

    expect(
      await runCli([...base, '--environment', 'production'], { env, ...io(capture()) }),
    ).toBe(0)

    const refused = capture()
    expect(
      await runCli([...base, '--environment', 'staging'], { env, ...io(refused) }),
    ).toBe(2)
    expect(refused.stderr.join('')).toContain('requires --yes')

    const unapproved = capture()
    expect(
      await runCli([...base, '--environment', 'staging', '--yes'], { env, ...io(unapproved) }),
    ).toBe(2)
    expect(unapproved.stderr.join('')).toContain('distinct approvals')

    // Two approvals bound to the *asset change* digest, recorded by two
    // identities (the repository path a second operator would use).
    const next = productionAsset({ environment: 'staging' })
    const digest = assetProtectionDigest(next)
    await withRepo(db, async (repo) => {
      for (const approver of ['os:bob', 'os:carol']) {
        await repo.approvals.record({
          id: newId('apr'),
          targetId: next.targetId,
          configDigest: digest,
          approver,
          approverOs: approver,
          decision: 'approve',
          reason: null,
          createdAt: new Date().toISOString(),
        })
      }
    })

    const applied = capture()
    expect(
      await runCli([...base, '--environment', 'staging', '--yes'], { env, ...io(applied) }),
    ).toBe(0)
    const stored = await withRepo(db, (repo) => repo.assets.get(asTargetId(TARGET)))
    expect(stored?.environment).toBe('staging')
    const events = await pendingOutbox(db)
    expect(events.some((event) => event['event'] === 'asset.protection.weakened')).toBe(true)
  })
})

describe('artifact verification evidence', () => {
  it('refuses a verified level without a checksum', async () => {
    const { db, input } = await workspace()
    const out = capture()
    const code = await runCli(
      [
        'artifact-add',
        '--db',
        db,
        '--target',
        TARGET,
        '--provider',
        'native-logical',
        '--kind',
        'full',
        '--path',
        input,
        '--verified-level',
        'V2',
      ],
      { ...io(out) },
    )
    expect(code).toBe(2)
    expect(out.stderr.join('')).toContain('--checksum')
  })

  it('records V2 evidence when verify passes', async () => {
    const { db, input } = await workspace()
    expect(
      await runCli(
        [
          'artifact-add',
          '--db',
          db,
          '--target',
          TARGET,
          '--provider',
          'native-logical',
          '--kind',
          'full',
          '--path',
          input,
        ],
        io(capture()),
      ),
    ).toBe(0)

    const executor = new FakeExecutor({
      defaultHandler: (cmd) => {
        if (cmd[0] === 'pg_restore' && cmd.includes('--list')) {
          return { stdout: ';     dbname: app\n' }
        }
        if (cmd[0] === 'psql' && cmd.some((arg) => arg.includes('pg_class'))) {
          return { stdout: 'public.t\t3\n' }
        }
        return {}
      },
    })

    const out = capture()
    const code = await runCli(
      ['verify', '--dsn', DSN, '--input', input, '--database', 'app', '--db', db],
      { executor, ...io(out) },
    )
    expect(code).toBe(0)
    expect(out.stderr.join('')).toContain('recorded as V2')

    const artifact = await withRepo(db, async (repo) => {
      const rows = await repo.artifacts.list({})
      return rows[0]
    })
    expect(artifact?.verifiedLevel).toBe('V2')
    expect(artifact?.verifiedAt).not.toBeNull()
    expect(artifact?.checksum).toMatch(/^[0-9a-f]{64}$/)
  })
})

const BACKUP_LABEL = [
  'START WAL LOCATION: 0/16B3748 (file 000000010000000000000016)',
  'CHECKPOINT LOCATION: 0/16B3780',
  'BACKUP METHOD: streamed',
  'BACKUP FROM: primary',
  'START TIME: 2026-01-04 09:12:33 UTC',
  'LABEL: pg_basebackup base backup',
  'START TIMELINE: 1',
].join('\n')

const BASIC_ARCHIVED = JSON.stringify({
  ...(JSON.parse(BASIC) as Record<string, unknown>),
  lastArchivedWal: '000000010000000000000002',
})

/** Probe responder that also reports an archived WAL segment. */
function archivedProbeExecutor(): FakeExecutor {
  return new FakeExecutor({
    defaultHandler: (cmd) => {
      const line = cmd.join(' ')
      if (line.includes('json_build_object')) return { stdout: BASIC_ARCHIVED }
      if (line.includes('pg_control_system')) return { stdout: SYSTEM_IDENTIFIER }
      return {}
    },
  })
}

describe('plan transport selection', () => {
  it('runs a remote plan through the transport executor and never the local one', async () => {
    const { db } = await workspace()
    const remote = new FakeExecutor({ defaultHandler: () => ({}) })
    const local = new FakeExecutor({ defaultHandler: () => ({}) })
    const plan = {
      ...planWithRisk('reversible'),
      transport: { kind: 'ssh' as const, host: 'dba@db1', knownHostsFile: '/etc/kh' },
    }

    const execution = await executePlan(plan, instanceInfo(), {
      executor: local,
      writeError: () => undefined,
      controlDb: db,
      executorForTransport: () => remote,
    })

    expect(execution.result.status).toBe('succeeded')
    expect(remote.calls).toHaveLength(1)
    expect(local.calls).toHaveLength(0)
    expect(execution.result.planId).toBe(plan.planId)
  })

  it('refuses environment credentials for a remote plan before any subprocess', async () => {
    const { db } = await workspace()
    const remote = new FakeExecutor({ defaultHandler: () => ({}) })
    const local = new FakeExecutor({ defaultHandler: () => ({}) })
    const plan = {
      ...planWithRisk('reversible'),
      transport: { kind: 'ssh' as const, host: 'dba@db1', knownHostsFile: '/etc/kh' },
    }

    const execution = await executePlan(plan, instanceInfo(), {
      executor: local,
      writeError: () => undefined,
      controlDb: db,
      executorForTransport: () => remote,
      env: { PGPASSWORD: 'secret' },
    })

    expect(execution.result.status).toBe('failed')
    expect(execution.result.error).toContain('do not forward')
    expect(execution.lease).toBeNull()
    expect(remote.calls).toHaveLength(0)
    expect(local.calls).toHaveLength(0)
  })

  it('rejects malformed transport flags before dispatch', async () => {
    const missingHost = capture()
    expect(await runCli(['inspect', '--transport', 'ssh', '--dsn', DSN], { ...io(missingHost) })).toBe(2)
    expect(missingHost.stderr.join('')).toContain('--ssh-host')

    const missingKnownHosts = capture()
    expect(
      await runCli(['inspect', '--transport', 'ssh', '--ssh-host', 'dba@db1', '--dsn', DSN], {
        ...io(missingKnownHosts),
      }),
    ).toBe(2)
    expect(missingKnownHosts.stderr.join('')).toContain('--known-hosts')

    const stray = capture()
    expect(
      await runCli(['inspect', '--transport', 'local', '--ssh-host', 'dba@db1', '--dsn', DSN], {
        ...io(stray),
      }),
    ).toBe(2)
    expect(stray.stderr.join('')).toContain('only valid with')

    const unknown = capture()
    expect(await runCli(['inspect', '--transport', 'telnet', '--dsn', DSN], { ...io(unknown) })).toBe(2)
    expect(unknown.stderr.join('')).toContain('unsupported transport')
  })

  it('rejects a transport on a control-plane-only command', async () => {
    const { db } = await workspace()
    const out = capture()
    expect(
      await runCli(
        ['metrics', '--transport', 'ssh', '--ssh-host', 'dba@db1', '--known-hosts', '/etc/kh', '--db', db],
        { ...io(out) },
      ),
    ).toBe(2)
    expect(out.stderr.join('')).toContain('applies to')
    expect(out.stderr.join('')).toContain('metrics')
  })
})

describe('remote exec surface', () => {
  it('requires a transport, a target and a command', async () => {
    const noArgv = capture()
    expect(await runCli(['exec', '--transport', 'ssh'], { ...io(noArgv) })).toBe(2)
    expect(noArgv.stderr.join('')).toContain('command after --')

    const noHost = capture()
    expect(await runCli(['exec', '--transport', 'ssh', '--', 'true'], { ...io(noHost) })).toBe(2)
    expect(noHost.stderr.join('')).toContain('--host and --known-hosts')

    const noPod = capture()
    expect(await runCli(['exec', '--transport', 'kubectl', '--', 'true'], { ...io(noPod) })).toBe(2)
    expect(noPod.stderr.join('')).toContain('--pod')

    const unknown = capture()
    expect(
      await runCli(['exec', '--transport', 'telnet', '--', 'true'], { ...io(unknown) }),
    ).toBe(2)
    expect(unknown.stderr.join('')).toContain('unsupported transport')
  })
})

describe('SMTP alert channel', () => {
  it('refuses --smtp without SMTP configuration', async () => {
    const out = capture()
    const env = { ...process.env }
    delete (env as Record<string, string | undefined>).BKAGENT_SMTP_HOST
    expect(await runCli(['notify-test', '--smtp'], { env, ...io(out) })).toBe(2)
    expect(out.stderr.join('')).toContain('BKAGENT_SMTP_HOST')
  })

  it('reports an incomplete SMTP configuration instead of silently disabling alerts', async () => {
    const out = capture()
    expect(
      await runCli(['notify-test', '--smtp'], {
        env: { ...process.env, BKAGENT_SMTP_HOST: '127.0.0.1' },
        ...io(out),
      }),
    ).toBe(2)
    expect(out.stderr.join('')).toContain('BKAGENT_SMTP_FROM')
  })
})

describe('provider contract surface', () => {
  it('lists every registered provider without a server', async () => {
    const out = capture()
    expect(await runCli(['providers'], { ...io(out) })).toBe(0)
    const payload = JSON.parse(out.stdout.join('')) as {
      engine: { id: string; versionRange: { min: string; max?: string } }
      providers: { id: string; capabilities: string[]; ownership: string }[]
    }
    expect(payload.engine.id).toBe('postgres')
    expect(payload.engine.versionRange).toEqual({ min: '14', max: '17' })
    expect(payload.providers.map((provider) => provider.id).sort()).toEqual([
      'native-logical',
      'native-physical',
      'pgbackrest',
      'walg',
    ])
    for (const provider of payload.providers) {
      expect(provider.capabilities.length).toBeGreaterThan(0)
      expect(['managed', 'provider-owned']).toContain(provider.ownership)
    }
  })

  it('fails closed when a provider tool is missing', async () => {
    const respond = (version: 'ok' | 'missing') => (cmd: readonly string[]) => {
      if (cmd.includes('--version')) {
        return version === 'ok'
          ? { stdout: `${cmd[0]} 99.0` }
          : { exitCode: 127, stderr: 'command not found' }
      }
      const line = cmd.join(' ')
      if (line.includes('json_build_object')) return { stdout: BASIC }
      if (line.includes('pg_control_system')) return { stdout: SYSTEM_IDENTIFIER }
      return {}
    }

    const healthy = capture()
    expect(
      await runCli(['providers', '--dsn', DSN], {
        executor: new FakeExecutor({ defaultHandler: respond('ok') }),
        ...io(healthy),
      }),
    ).toBe(0)
    const okPayload = JSON.parse(healthy.stdout.join('')) as {
      providers: { preflight: { ok: boolean } }[]
    }
    expect(okPayload.providers.every((provider) => provider.preflight.ok)).toBe(true)

    const broken = capture()
    expect(
      await runCli(['providers', '--dsn', DSN], {
        executor: new FakeExecutor({ defaultHandler: respond('missing') }),
        ...io(broken),
      }),
    ).toBe(1)
    const badPayload = JSON.parse(broken.stdout.join('')) as {
      providers: { preflight: { ok: boolean; issues: { code: string }[] } }[]
    }
    expect(
      badPayload.providers.some((provider) =>
        provider.preflight.issues.some((issue) => issue.code === 'TOOL_MISSING'),
      ),
    ).toBe(true)
  })
})

describe('PITR recoverable window', () => {
  it('refuses a target LSN before the base backup consistent point', async () => {
    const { dir, db } = await workspace()
    const dataDir = join(dir, 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'backup_label'), BACKUP_LABEL)

    const out = capture()
    const code = await runCli(
      [
        'pitr',
        '--dsn',
        DSN,
        '--data-dir',
        dataDir,
        '--port',
        '55420',
        '--log',
        join(dir, 'recovery.log'),
        '--restore-command',
        'cp /archive/%f %p',
        '--target-lsn',
        '0/1',
        '--yes',
        '--db',
        db,
      ],
      { executor: archivedProbeExecutor(), ...io(out) },
    )
    expect(code).toBe(4)
    const payload = JSON.parse(out.stdout.join('')) as { issues: { code: string }[] }
    expect(payload.issues.map((issue) => issue.code)).toContain('PITR_TARGET_BEFORE_BACKUP')
  })

  it('lets an in-window target reach the authorization gate', async () => {
    const { dir, db } = await workspace()
    const dataDir = join(dir, 'data')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'backup_label'), BACKUP_LABEL)

    const out = capture()
    const code = await runCli(
      [
        'pitr',
        '--dsn',
        DSN,
        '--data-dir',
        dataDir,
        '--port',
        '55420',
        '--log',
        join(dir, 'recovery.log'),
        '--restore-command',
        'cp /archive/%f %p',
        '--target-lsn',
        '0/2000000',
        '--yes',
        '--db',
        db,
      ],
      { executor: archivedProbeExecutor(), ...io(out) },
    )
    // Preflight passed, so the refusal now comes from the missing asset.
    expect(code).toBe(2)
    expect(out.stderr.join('')).toContain('no asset registered')
  })
})

describe('watchdog alerts', () => {
  it('raises P1 for a registered target with no verified restore point', async () => {
    const { db } = await workspace()
    await withRepo(db, (repo) => repo.assets.upsert(productionAsset()))

    const out = capture()
    expect(await runCli(['watchdog', '--db', db], { ...io(out) })).toBe(0)
    const report = JSON.parse(out.stdout.join('')) as {
      alerts: { severity: string; title: string }[]
      delivery: { sent: number }
    }
    expect(report.alerts[0]?.severity).toBe('P1')
    expect(report.alerts[0]?.title).toContain(TARGET)
    // No webhook configured: nothing is sent, nothing fails.
    expect(report.delivery).toEqual({ sent: 0, failed: [] })
  })
})

describe('artifact storage sink', () => {
  async function seedStaging(dir: string, name = 'staging.dump'): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, 'payload')
    return path
  }

  it('uploads a successful artifact, records its location and removes the staging file', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'store')
    const staging = await seedStaging(dir)
    const plan = planWithRisk('reversible')

    const execution = await executePlan(plan, instanceInfo(), {
      executor: new FakeExecutor({ defaultHandler: () => ({}) }),
      writeError: () => undefined,
      controlDb: db,
      artifact: { path: staging, kind: 'logical', verifiedLevel: 'V1' },
      artifactSink: fsArtifactSink({ root, keepsLocalCopy: false }),
    })

    expect(execution.result.status).toBe('succeeded')
    const rows = await withRepo(db, (repo) => repo.artifacts.list({}))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.path.startsWith(root)).toBe(true)
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]?.sizeBytes).toBe(7)
    expect(rows[0]?.verifiedLevel).toBe('V1')
    expect(existsSync(staging)).toBe(false)
  })

  it('fails the run and records no artifact when the upload fails', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'store')
    const plan = planWithRisk('reversible')

    const execution = await executePlan(plan, instanceInfo(), {
      executor: new FakeExecutor({ defaultHandler: () => ({}) }),
      writeError: () => undefined,
      controlDb: db,
      artifact: { path: join(dir, 'missing.dump'), kind: 'logical', verifiedLevel: 'V1' },
      artifactSink: fsArtifactSink({ root, keepsLocalCopy: false }),
    })

    expect(execution.result.status).toBe('failed')
    expect(execution.result.error).toContain('artifact storage failed')
    const rows = await withRepo(db, (repo) => repo.artifacts.list({}))
    expect(rows).toEqual([])
    expect(execution.persistence?.persisted).toBe(true)
  })

  it('refuses a storage sink for a remote plan before running', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'store')
    const remote = new FakeExecutor({ defaultHandler: () => ({}) })
    const plan = {
      ...planWithRisk('reversible'),
      transport: { kind: 'ssh' as const, host: 'dba@db1', knownHostsFile: '/etc/kh' },
    }

    const execution = await executePlan(plan, instanceInfo(), {
      executor: new FakeExecutor({ defaultHandler: () => ({}) }),
      writeError: () => undefined,
      controlDb: db,
      executorForTransport: () => remote,
      artifact: { path: '/var/backups/app.dump', kind: 'logical', verifiedLevel: 'V1' },
      artifactSink: fsArtifactSink({ root }),
    })

    expect(execution.result.status).toBe('failed')
    expect(execution.result.error).toContain('artifact sink is configured')
    expect(remote.calls).toHaveLength(0)
  })

  it('marks a remote artifact path with its transport instead of pretending it is local', async () => {
    const { db } = await workspace()
    const plan = {
      ...planWithRisk('reversible'),
      transport: { kind: 'ssh' as const, host: 'dba@db1', knownHostsFile: '/etc/kh' },
    }

    const execution = await executePlan(plan, instanceInfo(), {
      executor: new FakeExecutor({ defaultHandler: () => ({}) }),
      writeError: () => undefined,
      controlDb: db,
      executorForTransport: () => new FakeExecutor({ defaultHandler: () => ({}) }),
      artifact: { path: '/var/backups/app.dump', kind: 'logical', verifiedLevel: 'V1' },
    })

    expect(execution.result.status).toBe('succeeded')
    const rows = await withRepo(db, (repo) => repo.artifacts.list({}))
    expect(rows[0]?.path).toBe('ssh:dba@db1:/var/backups/app.dump')
  })
})

describe('artifact-upload', () => {
  async function insertArtifact(
    db: string,
    path: string,
    provider = 'native-logical',
  ): Promise<string> {
    const id = asArtifactId(newId('art'))
    await withRepo(db, (repo) =>
      repo.artifacts.insert({
        id,
        planId: null,
        targetId: asTargetId(TARGET),
        provider,
        kind: 'full',
        parentId: null,
        path,
        sizeBytes: 7,
        checksum: null,
        verifiedLevel: 'V1',
        verifiedAt: new Date().toISOString(),
        protected: false,
        createdAt: new Date().toISOString(),
      }),
    )
    return String(id)
  }

  it('moves a cataloged artifact into configured storage and records the digest', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'store')
    const staging = join(dir, 'staging.dump')
    await writeFile(staging, 'payload')
    const id = await insertArtifact(db, staging)

    const out = capture()
    expect(
      await runCli(
        ['artifact-upload', '--db', db, '--id', id, '--storage-kind', 'fs', '--storage-root', root, '--remove-local'],
        { ...io(out) },
      ),
    ).toBe(0)
    const payload = JSON.parse(out.stdout.join('')) as {
      location: string
      bytes: number
      digest: string
      removedLocal: boolean
    }
    expect(payload.location.startsWith(root)).toBe(true)
    expect(payload.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.removedLocal).toBe(true)
    expect(existsSync(staging)).toBe(false)

    const row = await withRepo(db, (repo) => repo.artifacts.get(asArtifactId(id)))
    expect(row?.path).toBe(payload.location)
    expect(row?.checksum).toBe(payload.digest)
    const events = await pendingOutbox(db)
    expect(events.some((event) => event['event'] === 'artifact.stored')).toBe(true)
  })

  it('refuses to move a provider-owned artifact and unknown ids', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'store')
    const staging = join(dir, 'staging.dump')
    await writeFile(staging, 'payload')
    const id = await insertArtifact(db, staging, 'pgbackrest')

    const owned = capture()
    expect(
      await runCli(
        ['artifact-upload', '--db', db, '--id', id, '--storage-kind', 'fs', '--storage-root', root],
        { ...io(owned) },
      ),
    ).toBe(2)
    expect(owned.stderr.join('')).toContain('ADR-003')

    const missing = capture()
    expect(
      await runCli(
        ['artifact-upload', '--db', db, '--id', 'art_missing', '--storage-kind', 'fs', '--storage-root', root],
        { ...io(missing) },
      ),
    ).toBe(4)
    expect(missing.stderr.join('')).toContain('no artifact')
  })

  it('requires a storage configuration', async () => {
    const { db } = await workspace()
    const out = capture()
    expect(await runCli(['artifact-upload', '--db', db, '--id', 'art_x'], { ...io(out) })).toBe(2)
    expect(out.stderr.join('')).toContain('--storage-kind')
  })
})

describe('storage purge and GC', () => {
  async function seedTombstone(
    db: string,
    filePath: string,
    overrides: Partial<Parameters<Repository['artifacts']['insert']>[0]> = {},
  ): Promise<string> {
    const id = asArtifactId(newId('art'))
    await withRepo(db, (repo) =>
      repo.artifacts.insert({
        id,
        planId: null,
        targetId: asTargetId(TARGET),
        provider: 'native-logical',
        kind: 'full',
        parentId: null,
        path: filePath,
        sizeBytes: 5,
        checksum: null,
        verifiedLevel: null,
        verifiedAt: null,
        protected: false,
        createdAt: new Date().toISOString(),
        lifecycleState: 'tombstoned',
        tombstonedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        ...overrides,
      }),
    )
    return String(id)
  }

  it('purges a reviewed tombstone and records an audit event', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'storage')
    await mkdir(join(root, 'target'), { recursive: true })
    const filePath = join(root, 'target', 'base.dump')
    await writeFile(filePath, 'bytes')
    await seedTombstone(db, filePath)

    const dry = capture()
    expect(await runCli(['storage-purge', '--db', db, '--storage-root', root], { ...io(dry) })).toBe(0)
    const plan = JSON.parse(dry.stdout.join('')) as {
      digest: string
      candidates: { id: string; key: string }[]
      skipped: Record<string, number>
    }
    expect(plan.candidates).toHaveLength(1)
    expect(plan.candidates[0]?.key).toBe('target/base.dump')
    expect(plan.skipped).toEqual({})

    const applied = capture()
    expect(
      await runCli(
        ['storage-purge', '--db', db, '--storage-root', root, '--apply', '--yes', '--digest', plan.digest],
        { ...io(applied) },
      ),
    ).toBe(0)
    const report = JSON.parse(applied.stdout.join('')) as { purged: string[]; failed: unknown[] }
    expect(report.purged).toHaveLength(1)
    expect(report.failed).toEqual([])
    expect(existsSync(filePath)).toBe(false)
    const events = await pendingOutbox(db)
    expect(events.some((event) => event['event'] === 'artifact.purged')).toBe(true)
  })

  it('refuses a digest that does not match the reviewed plan', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'storage')
    await mkdir(root, { recursive: true })
    const filePath = join(root, 'a.dump')
    await writeFile(filePath, 'bytes')
    await seedTombstone(db, filePath)

    const out = capture()
    expect(
      await runCli(
        ['storage-purge', '--db', db, '--storage-root', root, '--apply', '--yes', '--digest', 'deadbeef'],
        { ...io(out) },
      ),
    ).toBe(2)
    expect(out.stderr.join('')).toContain('digest mismatch')
    expect(existsSync(filePath)).toBe(true)
  })

  it('deletes an aged orphan and keeps a referenced object', async () => {
    const { dir, db } = await workspace()
    const root = join(dir, 'storage')
    await mkdir(root, { recursive: true })
    const orphan = join(root, 'orphan.bin')
    const kept = join(root, 'kept.dump')
    await writeFile(orphan, 'orphan')
    await writeFile(kept, 'kept')
    const old = new Date(Date.now() - 30 * 86_400_000)
    utimesSync(orphan, old, old)
    await withRepo(db, (repo) =>
      repo.artifacts.insert({
        id: asArtifactId(newId('art')),
        planId: null,
        targetId: asTargetId(TARGET),
        provider: 'native-logical',
        kind: 'full',
        parentId: null,
        path: kept,
        sizeBytes: 4,
        checksum: null,
        verifiedLevel: null,
        verifiedAt: null,
        protected: false,
        createdAt: new Date().toISOString(),
      }),
    )

    const dry = capture()
    expect(await runCli(['storage-gc', '--db', db, '--storage-root', root], { ...io(dry) })).toBe(0)
    const plan = JSON.parse(dry.stdout.join('')) as {
      digest: string
      delete: { key: string }[]
      referenced: number
    }
    expect(plan.delete.map((entry) => entry.key)).toEqual(['orphan.bin'])
    expect(plan.referenced).toBe(1)

    const applied = capture()
    expect(
      await runCli(
        ['storage-gc', '--db', db, '--storage-root', root, '--apply', '--yes', '--digest', plan.digest],
        { ...io(applied) },
      ),
    ).toBe(0)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })
})

describe('metrics exposition', () => {
  it('emits the §12 series from control-database facts', async () => {
    const { db } = await workspace()
    await withRepo(db, (repo) => repo.assets.upsert(productionAsset()))

    const out = capture()
    expect(await runCli(['metrics', '--db', db], { ...io(out) })).toBe(0)
    const text = out.stdout.join('')
    expect(text).toContain('bk_rpo_attainment_ratio 0.000000')
    expect(text).toContain('bk_stalled_attempts_total 0')
    expect(text).toContain('bk_outbox_lag_seconds 0')
    expect(text).toContain('# TYPE bk_attempt_duration_seconds summary')
    expect(text).toMatch(/bk_outbox_lag_seconds \d+/)
  })
})

describe('capacity projection', () => {
  it('keeps bytes written before the window as the projection baseline', async () => {
    const { db } = await workspace()
    const day = 86_400_000
    const gb = 1024 ** 3
    const now = Date.now()

    await withRepo(db, async (repo) => {
      const rows = [
        { at: now - 30 * day, bytes: 100 * gb },
        { at: now - 6 * day, bytes: 1 * gb },
        { at: now - 1 * day, bytes: 1 * gb },
      ]
      for (const row of rows) {
        await repo.artifacts.insert({
          id: asArtifactId(newId('art')),
          planId: null,
          targetId: asTargetId(TARGET),
          provider: 'native-logical',
          kind: 'full',
          parentId: null,
          path: `/backups/${row.at}.dump`,
          sizeBytes: row.bytes,
          checksum: null,
          verifiedLevel: null,
          verifiedAt: null,
          protected: false,
          createdAt: new Date(row.at).toISOString(),
        })
      }
    })

    const out = capture()
    expect(
      await runCli(['capacity', '--db', db, '--days', '7', '--threshold-gb', '150'], {
        ...io(out),
      }),
    ).toBe(0)
    const forecast = JSON.parse(out.stdout.join('')) as {
      projectedBytes30d: number
      daysUntilThreshold: number | null
    }
    // Without the pre-window baseline the projection would start from ~2 GB.
    expect(forecast.projectedBytes30d).toBeGreaterThan(100 * gb)
    expect(forecast.daysUntilThreshold).not.toBeNull()

    const bad = capture()
    expect(await runCli(['capacity', '--db', db, '--threshold-gb', 'lots'], { ...io(bad) })).toBe(2)
    expect(bad.stderr.join('')).toContain('--threshold-gb')
  })
})

describe('availableBytesAt', () => {
  it('measures an existing directory and keeps an unknown destination permissive', async () => {
    const { dir } = await workspace()
    expect(availableBytesAt(dir)).toBeGreaterThan(0)
    expect(availableBytesAt(join(dir, 'not', 'created', 'yet'))).toBeGreaterThan(0)
    expect(availableBytesAt(undefined)).toBe(Number.MAX_SAFE_INTEGER)
  })
})
