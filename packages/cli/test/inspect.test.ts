import { describe, expect, it } from 'vitest'

import { FakeExecutor } from '@backup-agent/core/testkit'

import { inspectInstance, parseDsn } from '../src/inspect'

const DSN = 'postgresql://backup:secret@10.0.0.5:5433/app?sslmode=require'

const BASIC = JSON.stringify({
  version: 'PostgreSQL 16.15',
  serverVersionNum: 160015,
  currentUser: 'backup',
  currentDatabase: 'app',
  inRecovery: false,
  walLevel: 'replica',
  archiveMode: 'on',
  databases: ['app', 'postgres'],
})

function executorWith(control: { exitCode: number; stdout?: string; stderr?: string }): FakeExecutor {
  const executor = new FakeExecutor()
  executor.enqueue({
    match: (cmd) => cmd.some((arg) => arg.includes('json_build_object')),
    response: { stdout: BASIC },
  })
  executor.enqueue({
    match: (cmd) => cmd.some((arg) => arg.includes('pg_control_system')),
    response: control,
  })
  return executor
}

describe('parseDsn', () => {
  it('extracts connection fields', () => {
    expect(parseDsn(DSN)).toEqual({
      host: '10.0.0.5',
      port: '5433',
      user: 'backup',
      password: 'secret',
      database: 'app',
      sslmode: 'require',
    })
  })

  it('applies defaults', () => {
    expect(parseDsn('postgres://backup@db.internal/app')).toEqual({
      host: 'db.internal',
      port: '5432',
      user: 'backup',
      database: 'app',
    })
  })

  it('rejects unsupported schemes and missing user', () => {
    expect(() => parseDsn('mysql://root@localhost/app')).toThrow(/unsupported scheme/)
    expect(() => parseDsn('postgres://localhost/app')).toThrow(/must include a user/)
  })
})

describe('inspectInstance', () => {
  it('returns instance facts and keeps credentials out of argv', async () => {
    const executor = executorWith({ exitCode: 0, stdout: '7421000000000000001' })
    const info = await inspectInstance(executor, parseDsn(DSN))

    expect(info.serverVersionNum).toBe(160015)
    expect(info.systemIdentifier).toBe('7421000000000000001')
    expect(info.databases).toEqual(['app', 'postgres'])
    expect(info.executionSite).toBe('fake')

    for (const call of executor.calls) {
      expect(call.argv.join(' ')).not.toContain('secret')
      expect(call.opts?.env?.PGPASSWORD).toBe('secret')
    }
  })

  it('degrades when pg_control_system is not permitted', async () => {
    const executor = executorWith({
      exitCode: 1,
      stderr: 'ERROR: permission denied for function pg_control_system',
    })
    const info = await inspectInstance(executor, parseDsn(DSN))
    expect(info.systemIdentifier).toBeNull()
    expect(info.warnings[0]).toContain('pg_control_system unavailable')
  })

  it('maps connection failures to CONNECT_FAILED', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: (cmd) => cmd.some((arg) => arg.includes('json_build_object')),
      response: { exitCode: 2, stderr: 'psql: error: could not connect to server' },
    })
    await expect(inspectInstance(executor, parseDsn(DSN))).rejects.toMatchObject({
      code: 'CONNECT_FAILED',
    })
  })
})
