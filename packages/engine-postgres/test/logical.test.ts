import { describe, expect, it } from 'vitest'

import {
  asMandateId,
  asTicketId,
  parseDsn,
  validatePlan,
  type Capability,
  type PlanBuildContext,
  type PlanValidationContext,
} from '@backup-agent/core'
import {
  buildBackupArgv,
  buildLogicalBackupPlan,
  buildLogicalRestorePlan,
  buildLogicalVerifyPlan,
  buildRestoreArgv,
  requestDigest,
} from '../src/logical'

const connection = parseDsn('postgres://backup:secret@10.0.0.5:5433/app?sslmode=require')

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

/**
 * The SSH transport a remote target would carry. Plans must record it so the
 * execution seam can pick the executor from the Plan rather than a process
 * default.
 */
const sshTransport = {
  kind: 'ssh',
  host: 'dba@db1.internal',
  knownHostsFile: '/etc/backup-agent/known_hosts',
} as const

const validationContext: PlanValidationContext = {
  now: '2026-01-01T00:30:00.000Z',
  declaredCapabilities: new Set<Capability>([
    'logical',
    'verify-restore',
    'physical',
    'pitr',
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

describe('buildBackupArgv', () => {
  it('builds a custom-format dump without credentials', () => {
    const argv = buildBackupArgv({
      connection,
      database: 'app',
      outputPath: '/tmp/app.dump',
      format: 'custom',
      compression: 6,
    })
    expect(argv[0]).toBe('pg_dump')
    expect(argv).toContain('--format=custom')
    expect(argv).toContain('--file=/tmp/app.dump')
    expect(argv).toContain('--compress=6')
    expect(argv.join(' ')).not.toContain('secret')
  })

  it('supports directory format with parallel jobs', () => {
    const argv = buildBackupArgv({
      connection,
      database: 'app',
      outputPath: '/tmp/app.dir',
      format: 'directory',
      jobs: 4,
      tables: ['public.t1'],
      schemas: ['public'],
    })
    expect(argv).toContain('--jobs=4')
    expect(argv).toContain('--table=public.t1')
    expect(argv).toContain('--schema=public')
  })

  it('rejects jobs for non-directory formats', () => {
    expect(() =>
      buildBackupArgv({
        connection,
        database: 'app',
        outputPath: '/tmp/app.dump',
        format: 'custom',
        jobs: 2,
      }),
    ).toThrow(/jobs requires directory/)
  })
})

describe('buildLogicalBackupPlan', () => {
  it('produces dump and artifact-verification steps', () => {
    const plan = buildLogicalBackupPlan(
      { connection, database: 'app', outputPath: '/tmp/app.dump', format: 'custom' },
      ctx,
    )
    expect(plan.risk).toBe('read-only')
    expect(plan.provider).toBe('native-logical')
    expect(plan.fingerprint.systemIdentifier).toBe('sys-1')
    expect(plan.fingerprint.targetOid).toBe('16384')
    expect(plan.steps.map((step) => step.stepId)).toEqual(['dump', 'verify-artifact'])
    expect(plan.steps[1]?.dependsOn).toEqual(['dump'])
    expect(plan.requires).toEqual({ capabilities: ['logical'] })
    // The fixture instance reports no data size, so the estimate stays unknown.
    expect(plan.resources.estimatedBytes).toBe(0)
  })

  it('estimates local bytes from the probed data size', () => {
    const sized = { ...ctx, instance: { ...ctx.instance, dataBytes: 12_345 } }
    const backup = buildLogicalBackupPlan(
      { connection, database: 'app', outputPath: '/tmp/app.dump', format: 'custom' },
      sized,
    )
    expect(backup.resources.estimatedBytes).toBe(12_345)

    // A restore reads its input on the database host and writes nothing locally.
    const restore = buildLogicalRestorePlan(
      { connection, inputPath: '/tmp/app.dump', format: 'custom', database: 'app' },
      sized,
    )
    expect(restore.resources.estimatedBytes).toBe(0)
    expect(restore.requires).toEqual({ capabilities: ['logical'] })
  })

  it('skips artifact verification for plain format', () => {
    const plan = buildLogicalBackupPlan(
      { connection, database: 'app', outputPath: '/tmp/app.sql', format: 'plain' },
      ctx,
    )
    expect(plan.steps.map((step) => step.stepId)).toEqual(['dump'])
  })
})

describe('buildRestoreArgv', () => {
  it('builds a clean restore with owner mapping disabled', () => {
    const argv = buildRestoreArgv({
      connection,
      inputPath: '/tmp/app.dump',
      format: 'custom',
      database: 'app_restored',
      clean: true,
      ifExists: true,
      noOwner: true,
    })
    expect(argv[0]).toBe('pg_restore')
    expect(argv).toContain('--clean')
    expect(argv).toContain('--if-exists')
    expect(argv).toContain('--no-owner')
    expect(argv.at(-1)).toBe('/tmp/app.dump')
    expect(argv.join(' ')).not.toContain('secret')
  })

  it('uses psql for plain format', () => {
    const argv = buildRestoreArgv({
      connection,
      inputPath: '/tmp/app.sql',
      format: 'plain',
      database: 'app_restored',
    })
    expect(argv[0]).toBe('psql')
    expect(argv).toContain('--set=ON_ERROR_STOP=1')
  })
})

describe('buildLogicalRestorePlan', () => {
  it('creates the database first and marks the plan destructive', () => {
    const plan = buildLogicalRestorePlan(
      {
        connection,
        inputPath: '/tmp/app.dump',
        format: 'custom',
        database: 'app_restored',
        createDatabase: true,
      },
      ctx,
    )
    expect(plan.risk).toBe('destructive')
    expect(plan.steps.map((step) => step.stepId)).toEqual(['create-database', 'restore'])
    expect(plan.steps[1]?.dependsOn).toEqual(['create-database'])
  })

  it('marks every restore destructive, even without clean or database creation', () => {
    const plan = buildLogicalRestorePlan(
      { connection, inputPath: '/tmp/app.dump', format: 'custom', database: 'app' },
      ctx,
    )
    expect(plan.risk).toBe('destructive')
  })

  it('marks plain SQL restores destructive because input can contain DROP statements', () => {
    const plan = buildLogicalRestorePlan(
      { connection, inputPath: '/tmp/app.sql', format: 'plain', database: 'app' },
      ctx,
    )
    expect(plan.risk).toBe('destructive')
  })
})

describe('Plan transport', () => {
  function plansWith(context: PlanBuildContext) {
    return [
      buildLogicalBackupPlan(
        { connection, database: 'app', outputPath: '/tmp/app.dump', format: 'custom' },
        context,
      ),
      buildLogicalRestorePlan(
        { connection, inputPath: '/tmp/app.dump', format: 'custom', database: 'app' },
        context,
      ),
      buildLogicalVerifyPlan(
        { connection, inputPath: '/tmp/app.dump', format: 'custom' },
        context,
      ),
    ]
  }

  it('records the ssh transport on every plan and still validates', () => {
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

describe('requestDigest', () => {
  it('ignores passwords', () => {
    const base = {
      connection,
      database: 'app',
      outputPath: '/tmp/app.dump',
      format: 'custom' as const,
    }
    const other = { ...base, connection: { ...connection, password: 'other' } }
    expect(requestDigest(base)).toBe(requestDigest(other))
  })
})
