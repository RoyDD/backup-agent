import { describe, expect, it } from 'vitest'

import {
  asMandateId,
  asTicketId,
  parseDsn,
  runPlan,
  validatePlan,
  type Capability,
  type Plan,
  type PlanBuildContext,
  type PlanValidationContext,
} from '@backup-agent/core'
import { FakeExecutor } from '@backup-agent/core/testkit'

import {
  buildPgBackRestBackupPlan,
  buildPgBackRestExpirePlan,
  buildPgBackRestRestoreArgv,
  buildPgBackRestRestorePlan,
  buildPgBackRestVerifyPlan,
  buildWalGBackupPlan,
  buildWalGPrunePlan,
  buildWalGRestorePlan,
} from '../src/index'

const ctx: PlanBuildContext = {
  ticketId: asTicketId('tkt_1'),
  mandateId: asMandateId('mnd_1'),
  now: '2026-01-01T00:00:00.000Z',
  instance: {
    version: 'PostgreSQL 16.15',
    serverVersionNum: 160015,
    currentUser: 'backup',
    currentDatabase: 'app',
    databaseOid: '16384',
    inRecovery: false,
    systemIdentifier: 'sys-1',
    walLevel: 'replica',
    archiveMode: 'on',
    databases: ['app'],
    executionSite: 'local',
    warnings: [],
  },
  configDigest: 'cfg-1',
}

const base = { configPath: '/etc/pgbackrest.conf', stanza: 'main' }

/** The SSH transport a remote target would carry; Plans must record it. */
const sshTransport = {
  kind: 'ssh',
  host: 'dba@db1.internal',
  knownHostsFile: '/etc/backup-agent/known_hosts',
} as const

const validationContext: PlanValidationContext = {
  now: '2026-01-01T00:30:00.000Z',
  declaredCapabilities: new Set<Capability>([
    'physical',
    'incremental',
    'wal-archive',
    'verify-restore',
  ]),
  requiredCapabilities: [],
  mandate: {
    id: asMandateId('mnd_1'),
    ticketId: asTicketId('tkt_1'),
    principalId: 'user:roy',
    scope: 'restore',
    policyVersion: '1',
    allowedRisk: 'destructive',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T03:00:00.000Z',
  },
  resources: { availableBytes: 1_000_000, maxConcurrency: 4 },
  policyValid: true,
}

describe('pgBackRest', () => {
  it('builds stanza, check, backup and verify in order', () => {
    const plan = buildPgBackRestBackupPlan({ ...base, ensureStanza: true, type: 'diff' }, ctx)
    expect(plan.provider).toBe('pgbackrest')
    expect(plan.risk).toBe('read-only')
    expect(plan.requires).toEqual({ capabilities: ['physical'] })
    // pgBackRest writes into its own repository on the database host.
    expect(plan.resources.estimatedBytes).toBe(0)
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      'stanza-create',
      'check',
      'backup',
      'verify',
    ])
    expect(plan.steps[2]?.argv).toEqual([
      'pgbackrest',
      '--config=/etc/pgbackrest.conf',
      '--stanza=main',
      'backup',
      '--type=diff',
    ])
  })

  it('runs the documented commands through the executor', async () => {
    const executor = new FakeExecutor({
      defaultHandler: () => ({ stdout: 'ok' }),
    })
    const plan = buildPgBackRestBackupPlan(base, ctx)
    const result = await runPlan(plan, { executor, sleep: async () => undefined })
    expect(result.status).toBe('succeeded')
    expect(executor.calls.map((call) => call.argv[3])).toEqual(['check', 'backup', 'verify'])
  })

  it('builds a targeted restore and delegates pruning to expire', () => {
    const argv = buildPgBackRestRestoreArgv({
      ...base,
      dataDirectory: '/restore',
      target: { type: 'time', value: '2026-01-01 00:00:00+00' },
      action: 'promote',
      delta: true,
    })
    expect(argv).toContain('restore')
    expect(argv).toContain('--pg1-path=/restore')
    expect(argv).toContain('--type=time')
    expect(argv).toContain('--target=2026-01-01 00:00:00+00')
    expect(argv).toContain('--target-action=promote')
    expect(argv).toContain('--delta')

    const restorePlan = buildPgBackRestRestorePlan({ ...base, dataDirectory: '/restore' }, ctx)
    expect(restorePlan.risk).toBe('destructive')
    expect(restorePlan.requires).toEqual({ capabilities: ['physical'] })

    const expire = buildPgBackRestExpirePlan(base, ctx)
    expect(expire.requires).toEqual({ capabilities: ['physical'] })
    expect(expire.steps[0]?.argv).toEqual([
      'pgbackrest',
      '--config=/etc/pgbackrest.conf',
      '--stanza=main',
      'expire',
    ])
  })
})

describe('WAL-G', () => {
  it('pushes and fetches a backup', () => {
    const push = buildWalGBackupPlan({ dataDirectory: '/pgdata' }, ctx)
    expect(push.provider).toBe('walg')
    expect(push.requires).toEqual({ capabilities: ['physical'] })
    expect(push.steps[0]?.argv).toEqual(['wal-g', 'backup-push', '/pgdata'])

    const fetch = buildWalGRestorePlan({ dataDirectory: '/restore' }, ctx)
    expect(fetch.risk).toBe('destructive')
    expect(fetch.requires).toEqual({ capabilities: ['physical'] })
    expect(fetch.steps[0]?.argv).toEqual(['wal-g', 'backup-fetch', '/restore', 'LATEST'])
    expect(fetch.steps[0]?.preconditions).toEqual([
      { kind: 'pathAbsent', path: '/restore' },
    ])
  })

  it('delegates retention to wal-g delete', () => {
    const plan = buildWalGPrunePlan({ retainFull: 3 }, ctx)
    expect(plan.steps[0]?.argv).toEqual([
      'wal-g',
      'delete',
      'retain',
      'FULL',
      '3',
      '--confirm',
    ])
    expect(plan.risk).toBe('destructive')
    expect(plan.requires).toEqual({ capabilities: ['physical'] })
  })

  it('honours a custom binary path', () => {
    const plan = buildWalGBackupPlan({ dataDirectory: '/pgdata', command: '/opt/wal-g' }, ctx)
    expect(plan.steps[0]?.argv?.[0]).toBe('/opt/wal-g')
  })
})

describe('Plan transport', () => {
  function plansWith(context: PlanBuildContext): Plan[] {
    return [
      buildPgBackRestBackupPlan(base, context),
      buildPgBackRestRestorePlan({ ...base, dataDirectory: '/restore' }, context),
      buildPgBackRestExpirePlan(base, context),
      buildPgBackRestVerifyPlan({ config: base.configPath, stanza: base.stanza }, context),
      buildWalGBackupPlan({ dataDirectory: '/pgdata' }, context),
      buildWalGRestorePlan({ dataDirectory: '/restore' }, context),
      buildWalGPrunePlan({ retainFull: 3 }, context),
    ]
  }

  it('records the ssh transport on every provider plan and still validates', () => {
    for (const plan of plansWith({ ...ctx, transport: sshTransport })) {
      expect(plan.transport).toEqual(sshTransport)
      expect(validatePlan(plan, validationContext)).toEqual([])
    }
  })

  it('leaves transport undefined for a context that does not carry one', () => {
    for (const plan of plansWith(ctx)) {
      expect(plan.transport).toBeUndefined()
    }
  })
})
