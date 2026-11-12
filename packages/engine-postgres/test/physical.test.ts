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
  buildPhysicalBackupArgv,
  buildPhysicalBackupPlan,
  buildPitrConfig,
  buildPitrRestorePlan,
} from '../src/physical'

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

describe('buildPhysicalBackupArgv', () => {
  it('builds a plain base backup without credentials', () => {
    const argv = buildPhysicalBackupArgv({
      connection,
      outputPath: '/backups/base',
      format: 'plain',
    })
    expect(argv[0]).toBe('pg_basebackup')
    expect(argv).toContain('--pgdata=/backups/base')
    expect(argv).toContain('--format=plain')
    expect(argv).toContain('--wal-method=stream')
    expect(argv).toContain('--checkpoint=fast')
    expect(argv.join(' ')).not.toContain('secret')
  })

  it('supports tar with compression and rate limits', () => {
    const argv = buildPhysicalBackupArgv({
      connection,
      outputPath: '/backups/base.tar',
      format: 'tar',
      compression: 3,
      maxRate: '50M',
      label: 'nightly',
    })
    expect(argv).toContain('--format=tar')
    expect(argv).toContain('--compress=3')
    expect(argv).toContain('--max-rate=50M')
    expect(argv).toContain('--label=nightly')
  })
})

describe('buildPhysicalBackupPlan', () => {
  it('verifies a plain base backup', () => {
    const plan = buildPhysicalBackupPlan(
      { connection, outputPath: '/backups/base', format: 'plain' },
      ctx,
    )
    expect(plan.risk).toBe('read-only')
    expect(plan.provider).toBe('native-physical')
    expect(plan.steps.map((step) => step.stepId)).toEqual(['basebackup', 'verify-backup'])
    expect(plan.steps[1]?.dependsOn).toEqual(['basebackup'])
  })

  it('skips verification for tar archives', () => {
    const plan = buildPhysicalBackupPlan(
      { connection, outputPath: '/backups/base.tar', format: 'tar' },
      ctx,
    )
    expect(plan.steps.map((step) => step.stepId)).toEqual(['basebackup'])
  })
})

describe('buildPitrConfig', () => {
  it('renders recovery GUCs and escapes quotes', () => {
    const config = buildPitrConfig({
      connection,
      dataDirectory: '/data',
      port: '5556',
      logPath: '/tmp/rec.log',
      restoreCommand: "cp /archive/%f %p && echo 'done'",
      target: { time: '2026-01-01 00:00:00+00' },
      action: 'promote',
    })
    expect(config).toContain("restore_command = 'cp /archive/%f %p && echo ''done'''")
    expect(config).toContain("recovery_target_time = '2026-01-01 00:00:00+00'")
    expect(config).toContain("recovery_target_action = 'promote'")
  })
})

const pitrBase = {
  connection,
  dataDirectory: '/tmp/rec',
  port: '5556',
  logPath: '/tmp/rec.log',
  restoreCommand: 'cp /archive/%f %p',
} as const

const validationContext: PlanValidationContext = {
  now: '2026-01-01T00:30:00.000Z',
  declaredCapabilities: new Set<Capability>(['physical', 'pitr']),
  requiredCapabilities: [],
  mandate: {
    id: asMandateId('mnd_1'),
    ticketId: asTicketId('tkt_1'),
    principalId: 'user:roy',
    scope: 'pitr',
    policyVersion: '1',
    allowedRisk: 'destructive',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T03:00:00.000Z',
  },
  resources: { availableBytes: 1_000_000, maxConcurrency: 4 },
  policyValid: true,
}

function lastArgv(step: { argv?: readonly string[] } | undefined): string {
  return step?.argv?.[step.argv.length - 1] ?? ''
}

describe('buildPitrRestorePlan', () => {
  it('stages a paused recovery target before promoting', () => {
    const plan = buildPitrRestorePlan(
      {
        ...pitrBase,
        target: { lsn: '0/2000028' },
        existingAutoConf: 'shared_preload_libraries = \'pg_stat_statements\'\n',
        verifySql: 'select count(*) from t',
      },
      ctx,
    )
    expect(plan.risk).toBe('destructive')
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      'write-recovery-config',
      'write-recovery-signal',
      'start-instance',
      'assert-recovery-target',
      'promote-instance',
      'assert-promoted',
      'verify-data',
    ])
    expect(plan.steps[0]?.file?.content).toContain('shared_preload_libraries')
    expect(plan.steps[0]?.file?.content).toContain("recovery_target_lsn = '0/2000028'")
    expect(plan.steps[0]?.file?.content).toContain("recovery_target_action = 'pause'")

    const targetStep = plan.steps[3]
    expect(targetStep?.dependsOn).toEqual(['start-instance'])
    const targetSql = lastArgv(targetStep)
    expect(targetSql).toContain("pg_get_wal_replay_pause_state() = 'paused'")
    expect(targetSql).toContain('pg_wal_lsn_diff')
    expect(targetSql).toContain("'0/2000028'::pg_lsn")

    expect(plan.steps[4]?.argv).toEqual([
      'pg_ctl',
      '-D',
      '/tmp/rec',
      'promote',
      '-w',
      '-t',
      '60',
    ])
    expect(plan.steps[5]?.dependsOn).toEqual(['promote-instance'])
    const promotedSql = lastArgv(plan.steps[5])
    expect(promotedSql).toContain('not pg_is_in_recovery()')
    expect(promotedSql).toContain('pg_wal_lsn_diff')
    expect(plan.steps[6]?.dependsOn).toEqual(['assert-promoted'])
  })

  it('checks a time target and avoids shell metacharacters in the assertion', () => {
    const plan = buildPitrRestorePlan(
      { ...pitrBase, target: { time: '2026-01-01 00:00:00+00' } },
      ctx,
    )
    const targetStep = plan.steps[3]
    const sql = lastArgv(targetStep)
    expect(sql).toContain('pg_last_xact_replay_timestamp() is null or greatest')
    expect(sql).toContain("'2026-01-01 00:00:00+00'::timestamptz")
    for (const arg of targetStep?.argv ?? []) {
      expect(arg).not.toMatch(/[;|&$`><\n\r]/)
    }
  })

  it('relies on the paused state for name and xid targets', () => {
    for (const target of [{ name: 'before-drop' }, { xid: '12345' }]) {
      const plan = buildPitrRestorePlan({ ...pitrBase, target }, ctx)
      const sql = lastArgv(plan.steps[3])
      expect(sql).toContain("pg_get_wal_replay_pause_state() = 'paused'")
      expect(sql).not.toContain('pg_last_xact_replay_timestamp')
    }
  })

  it('leaves a pause action paused at the target', () => {
    const plan = buildPitrRestorePlan(
      { ...pitrBase, target: { name: 'before-drop' }, action: 'pause', verifySql: 'select 1' },
      ctx,
    )
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      'write-recovery-config',
      'write-recovery-signal',
      'start-instance',
      'assert-recovery-target',
      'verify-data',
    ])
    expect(plan.steps[4]?.dependsOn).toEqual(['assert-recovery-target'])
  })

  it('verifies the target before stopping for a shutdown action', () => {
    const plan = buildPitrRestorePlan(
      { ...pitrBase, target: { lsn: '0/2000028' }, action: 'shutdown', verifySql: 'select 1' },
      ctx,
    )
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      'write-recovery-config',
      'write-recovery-signal',
      'start-instance',
      'assert-recovery-target',
      'verify-data',
      'stop-instance',
    ])
    const stop = plan.steps[5]
    expect(stop?.dependsOn).toEqual(['verify-data'])
    expect(stop?.argv).toEqual([
      'pg_ctl',
      '-D',
      '/tmp/rec',
      'stop',
      '-m',
      'fast',
      '-w',
      '-t',
      '60',
    ])
    expect(stop?.postconditions).toEqual([
      { kind: 'pathAbsent', path: '/tmp/rec/postmaster.pid' },
    ])
  })

  it('stops directly after verification when shutdown has no verify SQL', () => {
    const plan = buildPitrRestorePlan(
      { ...pitrBase, target: { xid: '12345' }, action: 'shutdown' },
      ctx,
    )
    const stop = plan.steps.find((step) => step.stepId === 'stop-instance')
    expect(stop?.dependsOn).toEqual(['assert-recovery-target'])
  })

  it('fails closed for missing, multiple or malformed targets', () => {
    expect(() => buildPitrRestorePlan({ ...pitrBase, target: {} }, ctx)).toThrow(
      /exactly one recovery target/,
    )
    expect(() =>
      buildPitrRestorePlan(
        { ...pitrBase, target: { time: '2026-01-01 00:00:00+00', lsn: '0/2000028' } },
        ctx,
      ),
    ).toThrow(/exactly one recovery target/)
    expect(() =>
      buildPitrRestorePlan({ ...pitrBase, target: { lsn: 'not-an-lsn' } }, ctx),
    ).toThrow(/valid LSN/)
    expect(() =>
      buildPitrRestorePlan({ ...pitrBase, target: { xid: 'abc' } }, ctx),
    ).toThrow(/valid transaction id/)
    expect(() =>
      buildPitrRestorePlan({ ...pitrBase, target: { time: 'not-a-time' } }, ctx),
    ).toThrow(/valid timestamp/)
  })

  it('passes plan validation for every action', () => {
    for (const action of ['promote', 'pause', 'shutdown'] as const) {
      const plan = buildPitrRestorePlan(
        { ...pitrBase, target: { time: '2026-01-01 00:00:00+00' }, action },
        ctx,
      )
      expect(validatePlan(plan, validationContext)).toEqual([])
    }
  })
})
