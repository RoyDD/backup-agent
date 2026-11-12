import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { dispatchOutbox, deliveryPayload } from '../../src/persistence/outbox-dispatch'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { OutboxRecord, Repository } from '../../src/ports/repository'

const T0 = '2026-01-01T00:00:00.000Z'
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()

const repos: Repository[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function open(filename = ':memory:'): Promise<Repository> {
  const created = await createSqliteRepository({ filename })
  await created.migrate()
  repos.push(created)
  return created
}

async function openSharedFile(): Promise<[Repository, Repository]> {
  const dir = mkdtempSync(join(tmpdir(), 'bk-dispatch-'))
  dirs.push(dir)
  const filename = join(dir, 'control.db')
  return [await open(filename), await open(filename)]
}

function clock(start = T0): { now: () => string; advance: (ms: number) => void } {
  let current = Date.parse(start)
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms) => {
      current += ms
    },
  }
}

describe('dispatchOutbox', () => {
  it('retries a failing handler with bounded exponential backoff', async () => {
    const repo = await open()
    const time = clock()
    let attempts = 0
    const handled: OutboxRecord[] = []

    await repo.outbox.append({ topic: 'audit', payload: { n: 1 }, idempotencyKey: 'k-1', availableAt: T0 })

    const options = {
      handlers: {
        audit: async (record: OutboxRecord) => {
          attempts += 1
          if (attempts < 3) throw new Error(`boom-${attempts}`)
          handled.push(record)
        },
      },
      now: time.now,
      baseDelayMs: 100,
      maxDelayMs: 250,
      leaseMs: 10_000,
    }

    const first = await dispatchOutbox(repo, options)
    expect(first).toMatchObject({ claimed: 1, retried: 1, dispatched: 0 })
    expect(
      (await repo.outbox.claim({ now: at(50), limit: 1, leaseMs: 1_000 })).length,
    ).toBe(0)
    // Backoff after attempt 1 is baseDelayMs; the record is not available early.
    const notYet = await dispatchOutbox(repo, { ...options, now: () => at(50) })
    expect(notYet.claimed).toBe(0)

    const second = await dispatchOutbox(repo, { ...options, now: () => at(100) })
    expect(second).toMatchObject({ claimed: 1, retried: 1 })
    // Delay for attempt 2 is 200ms, clamped by maxDelayMs (250) only later.
    expect(await dispatchOutbox(repo, { ...options, now: () => at(250) })).toMatchObject({
      claimed: 0,
    })

    const third = await dispatchOutbox(repo, { ...options, now: () => at(300) })
    expect(third).toMatchObject({ claimed: 1, dispatched: 1 })
    expect(handled).toHaveLength(1)
    expect(await repo.outbox.countByStatus('dispatched')).toBe(1)
  })

  it('dead-letters a handler failure after max attempts', async () => {
    const repo = await open()
    const time = clock()
    await repo.outbox.append({ topic: 'audit', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })

    const options = {
      handlers: {
        audit: async () => {
          throw new Error('always broken')
        },
      },
      now: time.now,
      maxAttempts: 2,
      leaseMs: 10_000,
      baseDelayMs: 10,
    }

    expect(await dispatchOutbox(repo, options)).toMatchObject({ claimed: 1, retried: 1 })
    time.advance(10)
    expect(await dispatchOutbox(repo, options)).toMatchObject({
      claimed: 1,
      deadLettered: 1,
      retried: 0,
    })

    expect(await repo.outbox.countByStatus('failed')).toBe(1)
    const stats = await repo.outbox.stats(time.now())
    expect(stats.deadLetter).toBe(1)
    expect(stats.pending).toBe(0)
  })

  it('rejects confirmation when the handler outlives the claim lease', async () => {
    const repo = await open()
    const time = clock()
    await repo.outbox.append({ topic: 'audit', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })

    const report = await dispatchOutbox(repo, {
      handlers: {
        audit: async () => {
          // The delivery finishes after the claim lease expired, but before any
          // successor reclaimed the row.
          time.advance(2_000)
        },
      },
      now: time.now,
      leaseMs: 1_000,
    })

    expect(report).toMatchObject({ claimed: 1, dispatched: 0, stale: 1 })
    // The row stays processing and is reclaimable rather than falsely confirmed.
    expect(await repo.outbox.countByStatus('processing')).toBe(1)
    const reclaimed = await repo.outbox.claim({ now: time.now(), limit: 1, leaseMs: 1_000 })
    expect(reclaimed[0]?.deliveryToken).toBe(2)
  })

  it('bases a retry on the failure time, not the claim time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-dispatch-'))
    dirs.push(dir)
    const filename = join(dir, 'control.db')
    const repo = await open(filename)
    const time = clock()
    const record = await repo.outbox.append({
      topic: 'audit',
      payload: {},
      idempotencyKey: 'k-1',
      availableAt: T0,
    })

    const report = await dispatchOutbox(repo, {
      handlers: {
        audit: async () => {
          time.advance(900)
          throw new Error('slow failure')
        },
      },
      now: time.now,
      leaseMs: 1_000,
      baseDelayMs: 100,
    })

    expect(report).toMatchObject({ claimed: 1, retried: 1 })
    const handle = new DatabaseSync(filename)
    try {
      const row = handle
        .prepare('SELECT status, available_at, last_error FROM outbox WHERE id = ?')
        .get(record.id) as { status: string; available_at: string; last_error: string | null }
      // failure at T0+900 + 100ms backoff, not claim time T0+100.
      expect(row).toEqual({
        status: 'pending',
        available_at: at(1_000),
        last_error: 'slow failure',
      })
    } finally {
      handle.close()
    }
  })

  it('dead-letters an unknown topic without calling any handler', async () => {
    const repo = await open()
    await repo.outbox.append({ topic: 'nobody', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })

    const report = await dispatchOutbox(repo, {
      handlers: {},
      now: () => T0,
      maxAttempts: 5,
    })

    expect(report).toMatchObject({ claimed: 1, deadLettered: 1, unknownTopic: 1, dispatched: 0 })
    expect(await repo.outbox.countByStatus('failed')).toBe(1)
  })

  it('keeps the stored payload immutable and adds outbox_id only at delivery', async () => {
    const repo = await open()
    const stored = await repo.outbox.append({
      topic: 'audit',
      payload: { event: 'run.finished', planId: 'pln_1' },
      idempotencyKey: 'run:pln_1:att_1:audit',
      availableAt: T0,
    })
    const received: OutboxRecord[] = []

    const report = await dispatchOutbox(repo, {
      handlers: { audit: async (record) => void received.push(record) },
      now: () => T0,
    })

    expect(report.dispatched).toBe(1)
    expect(received[0]?.id).toBe(stored.id)
    expect(received[0]?.idempotencyKey).toBe('run:pln_1:att_1:audit')
    expect(received[0]?.payload).toEqual({ event: 'run.finished', planId: 'pln_1' })
    expect(deliveryPayload(received[0]!)).toEqual({
      event: 'run.finished',
      planId: 'pln_1',
      outbox_id: stored.id,
      idempotency_key: 'run:pln_1:att_1:audit',
    })

    expect(await repo.outbox.countByStatus('dispatched')).toBe(1)
  })

  it('rejects the confirmation of a consumer whose record was reclaimed', async () => {
    const [first, second] = await openSharedFile()
    const record = await first.outbox.append({
      topic: 'audit',
      payload: {},
      idempotencyKey: 'k-1',
      availableAt: T0,
    })

    const report = await dispatchOutbox(first, {
      handlers: {
        audit: async () => {
          // Another process reclaims the row while the first consumer is busy.
          const [reclaimed] = await second.outbox.claim({
            now: at(2_000),
            limit: 1,
            leaseMs: 10_000,
          })
          expect(reclaimed?.deliveryToken).toBe(2)
          expect(
            await second.outbox.markDispatched(record.id, {
              now: at(2_000),
              token: reclaimed!.deliveryToken,
            }),
          ).toBe(true)
        },
      },
      now: () => T0,
      leaseMs: 1_000,
    })

    expect(report).toMatchObject({ claimed: 1, dispatched: 0, stale: 1 })
    expect(await first.outbox.countByStatus('dispatched')).toBe(1)
  })
})
