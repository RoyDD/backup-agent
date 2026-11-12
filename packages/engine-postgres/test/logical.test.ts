import { describe, expect, it } from 'vitest'

import { asMandateId, asTicketId, parseDsn, type PlanBuildContext } from '@backup-agent/core'
import {
  buildBackupArgv,
  buildLogicalBackupPlan,
  buildLogicalRestorePlan,
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
