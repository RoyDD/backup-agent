import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OutboxId } from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'

import { runCli } from '../src/cli'

const WEBHOOK = 'https://alerts.invalid/hooks/bkagent?token=do-not-leak'

const workspaces: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function controlDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bkagent-outbox-'))
  workspaces.push(dir)
  return join(dir, 'control.db')
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

async function appendNotify(db: string, idempotencyKey = 'k-1'): Promise<OutboxId> {
  const repo = await createSqliteRepository({ filename: db })
  try {
    await repo.migrate()
    const record = await repo.outbox.append({
      topic: 'notify.failure',
      payload: {
        severity: 'P2',
        title: 'backup failed: native-logical',
        message: 'pg_dump exited 2',
        labels: { targetId: 'pg-prod', planId: 'pln_1' },
      },
      idempotencyKey,
    })
    return record.id
  } finally {
    await repo.close()
  }
}

async function appendRaw(db: string, topic: string, key: string): Promise<OutboxId> {
  const repo = await createSqliteRepository({ filename: db })
  try {
    await repo.migrate()
    return (await repo.outbox.append({ topic, payload: {}, idempotencyKey: key })).id
  } finally {
    await repo.close()
  }
}

function readOutbox(db: string, id: OutboxId): { status: string; last_error: string | null } {
  const handle = new DatabaseSync(db)
  try {
    return handle
      .prepare('SELECT status, last_error FROM outbox WHERE id = ?')
      .get(id) as { status: string; last_error: string | null }
  } finally {
    handle.close()
  }
}

describe('outbox-dispatch', () => {
  it('delivers a failure notification with outbox_id and never leaks the webhook URL', async () => {
    const db = await controlDb()
    const outboxId = await appendNotify(db)
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
      return { ok: true, status: 200, text: async () => '' }
    })
    const out = capture()

    const code = await runCli(['outbox-dispatch', '--db', db, '--limit', '10', '--max-attempts', '3'], {
      stdout: out.write,
      stderr: out.writeError,
      env: { BKAGENT_WEBHOOK_URL: WEBHOOK },
    })

    expect(code).toBe(0)
    expect(JSON.parse(out.stdout.join(''))).toMatchObject({
      claimed: 1,
      dispatched: 1,
      retried: 0,
      deadLettered: 0,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(WEBHOOK)
    // Receiver-side dedupe metadata accompanies the immutable stored payload.
    expect(requests[0]?.body).toMatchObject({
      severity: 'P2',
      title: 'backup failed: native-logical',
      outbox_id: outboxId,
      idempotency_key: 'k-1',
      labels: { targetId: 'pg-prod', planId: 'pln_1' },
    })
    // The secret-bearing URL is configuration, never output.
    expect(out.stdout.join('') + out.stderr.join('') + JSON.stringify(requests[0]?.body)).not.toContain(
      'do-not-leak',
    )
    expect(readOutbox(db, outboxId).status).toBe('dispatched')
  })

  it('retries a failure notification when no webhook is configured', async () => {
    const db = await controlDb()
    const outboxId = await appendNotify(db)
    const out = capture()

    const code = await runCli(['outbox-dispatch', '--db', db, '--max-attempts', '3'], {
      stdout: out.write,
      stderr: out.writeError,
      env: {},
    })

    expect(code).toBe(0)
    expect(JSON.parse(out.stdout.join(''))).toMatchObject({ claimed: 1, retried: 1 })
    const row = readOutbox(db, outboxId)
    expect(row.status).toBe('pending')
    expect(row.last_error).toContain('BKAGENT_WEBHOOK_URL')
  })

  it('dead-letters an unknown topic', async () => {
    const db = await controlDb()
    const outboxId = await appendRaw(db, 'mystery.topic', 'k-unknown')
    const out = capture()

    const code = await runCli(['outbox-dispatch', '--db', db], {
      stdout: out.write,
      stderr: out.writeError,
      env: {},
    })

    expect(code).toBe(0)
    expect(JSON.parse(out.stdout.join(''))).toMatchObject({
      claimed: 1,
      unknownTopic: 1,
      deadLettered: 1,
      dispatched: 0,
    })
    const row = readOutbox(db, outboxId)
    expect(row.status).toBe('failed')
    expect(row.last_error).toContain('unknown outbox topic')
  })
})
