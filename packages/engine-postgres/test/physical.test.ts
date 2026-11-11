import { describe, expect, it } from 'vitest'

import {
  asMandateId,
  asTicketId,
  parseDsn,
  validatePlan,
  type PlanBuildContext,
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

describe('buildPitrRestorePlan', () => {
  it('writes config and signal, starts the instance and verifies promotion', () => {
    const plan = buildPitrRestorePlan(
      {
        connection,
        dataDirectory: '/tmp/rec',
        port: '5556',
        logPath: '/tmp/rec.log',
        restoreCommand: 'cp /archive/%f %p',
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
      'assert-promoted',
      'verify-data',
    ])
    expect(plan.steps[0]?.file?.content).toContain('shared_preload_libraries')
    expect(plan.steps[0]?.file?.content).toContain('recovery_target_lsn')
  })

  it('passes plan validation', () => {
    const plan = buildPitrRestorePlan(
      {
        connection,
        dataDirectory: '/tmp/rec',
        port: '5556',
        logPath: '/tmp/rec.log',
        restoreCommand: 'cp /archive/%f %p',
        target: { time: '2026-01-01 00:00:00+00' },
      },
      ctx,
    )
    const issues = validatePlan(plan, {
      now: '2026-01-01T00:30:00.000Z',
      declaredCapabilities: new Set(['physical', 'pitr']),
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
    })
    expect(issues).toEqual([])
  })
})
