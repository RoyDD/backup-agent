import { describe, expect, it } from 'vitest'

import { FakeExecutor } from '@backup-agent/core/testkit'

import { runCli } from '../src/cli'

const DSN = 'postgres://backup:secret@127.0.0.1:55416/app'
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

function successExecutor(): FakeExecutor {
  const executor = new FakeExecutor()
  executor.enqueue({
    match: (cmd) => cmd.some((arg) => arg.includes('json_build_object')),
    response: { stdout: BASIC },
  })
  executor.enqueue({
    match: (cmd) => cmd.some((arg) => arg.includes('pg_control_system')),
    response: { stdout: '7421000000000000001' },
  })
  return executor
}

describe('runCli', () => {
  it('prints usage for help', async () => {
    const out = capture()
    expect(await runCli(['help'], { stdout: out.write, stderr: out.writeError })).toBe(0)
    expect(out.stdout.join('')).toContain('bkagent inspect')
  })

  it('returns 2 without a command', async () => {
    const out = capture()
    expect(await runCli([], { stdout: out.write, stderr: out.writeError })).toBe(2)
  })

  it('requires a dsn', async () => {
    const out = capture()
    expect(await runCli(['inspect'], { stdout: out.write, stderr: out.writeError, env: {} })).toBe(2)
    expect(out.stderr.join('')).toContain('--dsn')
  })

  it('inspects a target and emits JSON', async () => {
    const out = capture()
    const code = await runCli(['inspect', '--dsn', DSN], {
      stdout: out.write,
      stderr: out.writeError,
      executor: successExecutor(),
      env: {},
    })
    expect(code).toBe(0)
    const payload = JSON.parse(out.stdout.join('')) as { serverVersionNum: number }
    expect(payload.serverVersionNum).toBe(160015)
    expect(out.stdout.join('')).not.toContain('secret')
  })

  it('supports text output', async () => {
    const out = capture()
    const code = await runCli(['inspect', '--dsn', DSN, '--format', 'text'], {
      stdout: out.write,
      stderr: out.writeError,
      executor: successExecutor(),
      env: {},
    })
    expect(code).toBe(0)
    expect(out.stdout.join('')).toContain('server_version_num: 160015')
  })

  it('returns 2 for an invalid dsn', async () => {
    const out = capture()
    const code = await runCli(['inspect', '--dsn', 'not-a-dsn'], {
      stdout: out.write,
      stderr: out.writeError,
      executor: successExecutor(),
      env: {},
    })
    expect(code).toBe(2)
    expect(out.stderr.join('')).toContain('INVALID_DSN')
  })

  it('returns 3 when the target cannot be reached', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: (cmd) => cmd.some((arg) => arg.includes('json_build_object')),
      response: { exitCode: 2, stderr: 'psql: error: could not connect to server' },
    })
    const out = capture()
    const code = await runCli(['inspect', '--dsn', DSN], {
      stdout: out.write,
      stderr: out.writeError,
      executor,
      env: {},
    })
    expect(code).toBe(3)
    expect(out.stderr.join('')).not.toContain('secret')
  })
})
