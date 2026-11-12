import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asTargetId } from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'
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

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function leaseWorkspace(): Promise<{ dir: string; db: string; dataDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bkagent-cli-lease-'))
  workspaces.push(dir)
  return { dir, db: join(dir, 'control.db'), dataDir: join(dir, 'data') }
}

describe('runCli plan execution leases', () => {
  it('leases the target and records the real token for a persisted run', async () => {
    const w = await leaseWorkspace()
    const output = join(w.dir, 'dump.sql')
    await writeFile(output, 'dump')
    const out = capture()
    const executor = new FakeExecutor({
      defaultHandler: (cmd) => {
        const line = cmd.join(' ')
        if (line.includes('json_build_object')) return { stdout: BASIC }
        if (line.includes('pg_control_system')) return { stdout: '7421000000000000001' }
        return { stdout: '' }
      },
    })

    const code = await runCli(
      ['backup', '--dsn', DSN, '--out', output, '--format', 'plain', '--db', w.db],
      { executor, stdout: out.write, stderr: out.writeError, env: { USER: 'roy' } },
    )

    expect(code).toBe(0)
    const repo = await createSqliteRepository({ filename: w.db })
    try {
      const attempts = await repo.attempts.listSince('2020-01-01T00:00:00.000Z')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.leaseToken).toBe(1)
      expect(attempts[0]?.owner.startsWith('os:roy:')).toBe(true)
      expect(attempts[0]?.state).toBe('succeeded')
      // Released in finally: no lease is left behind after the run.
      expect(await repo.leases.get(asTargetId('127.0.0.1:55416/app'))).toBeNull()
      expect(await repo.leases.currentFence(asTargetId('127.0.0.1:55416/app'))).toBe(1)
    } finally {
      await repo.close()
    }
  })

  it('records the run in the resolved control db even without an explicit --db', async () => {
    const w = await leaseWorkspace()
    const out = capture()
    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })

    const code = await runCli(['walg-backup', '--data-dir', w.dataDir], {
      executor,
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy', BKAGENT_DB: w.db },
    })

    expect(code).toBe(0)
    const repo = await createSqliteRepository({ filename: w.db })
    try {
      const target = asTargetId(`walg:${w.dataDir}`)
      // The resolved BKAGENT_DB is a real control db: the run envelope, terminal
      // state and audit outbox event are written even without --db.
      expect(await repo.leases.get(target)).toBeNull()
      expect(await repo.leases.currentFence(target)).toBe(1)
      const attempts = await repo.attempts.listSince('2020-01-01T00:00:00.000Z')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.state).toBe('succeeded')
      expect(attempts[0]?.targetId).toBe(target)
      expect(attempts[0]?.leaseToken).toBe(1)
      // start + terminal audit events
      expect(await repo.outbox.countByStatus('pending')).toBe(2)
      // plan→attempt from start; provider-managed runs add no artifact edge.
      expect(await repo.lineage.listFor('attempt', attempts[0]!.id)).toHaveLength(1)
    } finally {
      await repo.close()
    }
  })

  it('records every non-destructive plan path at the shared seam', async () => {
    const w = await leaseWorkspace()
    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })
    const env = { USER: 'roy', BKAGENT_DB: w.db }
    const out = capture()

    expect(
      await runCli(['walg-backup', '--data-dir', w.dataDir], {
        executor,
        stdout: out.write,
        stderr: out.writeError,
        env,
      }),
    ).toBe(0)
    expect(
      await runCli(['pgbackrest-backup', '--config', '/etc/pgbackrest.conf', '--stanza', 'main'], {
        executor,
        stdout: out.write,
        stderr: out.writeError,
        env,
      }),
    ).toBe(0)

    const repo = await createSqliteRepository({ filename: w.db })
    try {
      const attempts = await repo.attempts.listSince('2020-01-01T00:00:00.000Z')
      expect(attempts.map((attempt) => attempt.targetId)).toEqual([
        asTargetId(`walg:${w.dataDir}`),
        asTargetId('pgbackrest:main'),
      ])
      expect(attempts.every((attempt) => attempt.state === 'succeeded')).toBe(true)
      // one audit sequence per path
      expect(await repo.outbox.countByStatus('pending')).toBe(4)
    } finally {
      await repo.close()
    }
  })

  it('denies the run when another owner holds the target lease', async () => {
    const w = await leaseWorkspace()
    const target = asTargetId(`walg:${w.dataDir}`)
    const holder = await createSqliteRepository({ filename: w.db })
    try {
      await holder.migrate()
      const lease = await holder.transaction((tx) =>
        tx.leases.acquire({
          targetId: target,
          owner: 'other-worker',
          now: new Date().toISOString(),
          ttlMs: 60_000,
        }),
      )
      expect(lease?.token).toBe(1)
    } finally {
      await holder.close()
    }

    const out = capture()
    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })
    const code = await runCli(['walg-backup', '--data-dir', w.dataDir, '--db', w.db], {
      executor,
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })

    expect(code).toBe(1)
    const payload = JSON.parse(out.stdout.join('')) as { result: { status: string; error: string } }
    expect(payload.result.status).toBe('failed')
    expect(payload.result.error).toContain('lease unavailable')
    expect(executor.calls).toHaveLength(0)

    const repo = await createSqliteRepository({ filename: w.db })
    try {
      // Nothing was persisted for a denied run and the holder keeps the lease.
      expect(await repo.attempts.listSince('2020-01-01T00:00:00.000Z')).toEqual([])
      expect((await repo.leases.get(target))?.owner).toBe('other-worker')
    } finally {
      await repo.close()
    }
  })
})
