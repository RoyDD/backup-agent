import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { Repository } from '../../src/ports/repository'

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

/** Two handles on one control database, as two CLI processes would open it. */
async function openSharedFile(): Promise<[Repository, Repository]> {
  const dir = mkdtempSync(join(tmpdir(), 'bk-outbox-'))
  dirs.push(dir)
  const filename = join(dir, 'control.db')
  return [await open(filename), await open(filename)]
}

describe('OutboxStore', () => {
  it('deduplicates by idempotency key and keeps the first payload', async () => {
    const r = await open()
    const first = await r.outbox.append({
      topic: 'notify',
      payload: { a: 1 },
      idempotencyKey: 'k-1',
    })
    const second = await r.outbox.append({
      topic: 'notify',
      payload: { a: 2 },
      idempotencyKey: 'k-1',
    })
    expect(second.id).toBe(first.id)
    expect(second.payload).toEqual({ a: 1 })
    expect(await r.outbox.countByStatus('pending')).toBe(1)
  })

  it('claims pending records, leases them and advances the delivery token', async () => {
    const r = await open()
    await r.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })

    const claimed = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('processing')
    expect(claimed[0]?.attempts).toBe(1)
    expect(claimed[0]?.deliveryToken).toBe(1)
    expect(claimed[0]?.leaseExpiresAt).toBe('2026-01-01T00:00:01.000Z')

    const again = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    expect(again).toHaveLength(0)
  })

  it('reclaims a record after its lease expires and bumps the token again', async () => {
    const r = await open()
    await r.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })
    await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })

    const reclaimed = await r.outbox.claim({
      now: '2026-01-01T00:00:02.000Z',
      limit: 10,
      leaseMs: 1_000,
    })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.attempts).toBe(2)
    expect(reclaimed[0]?.deliveryToken).toBe(2)
  })

  it('dispatches and retries only with the current delivery token', async () => {
    const r = await open()
    const record = await r.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-1',
      availableAt: T0,
    })
    const [first] = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    expect(await r.outbox.markDispatched(record.id, { now: T0, token: first!.deliveryToken })).toBe(
      true,
    )
    expect(await r.outbox.countByStatus('dispatched')).toBe(1)

    const second = await r.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-2',
      availableAt: T0,
    })
    const [claimed] = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    expect(
      await r.outbox.markRetry(second.id, {
        now: T0,
        token: claimed!.deliveryToken,
        error: 'boom',
        retryAt: at(300_000),
      }),
    ).toBe(true)
    expect(await r.outbox.countByStatus('pending')).toBe(1)
    const retry = await r.outbox.claim({ now: at(300_000), limit: 10, leaseMs: 1_000 })
    expect(retry.map((row) => row.id)).toEqual([second.id])
  })

  it('rejects a confirmation from a consumer whose claim was reclaimed', async () => {
    const r = await open()
    const record = await r.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-1',
      availableAt: T0,
    })
    const [first] = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    const [reclaimed] = await r.outbox.claim({ now: at(2_000), limit: 10, leaseMs: 1_000 })
    expect(reclaimed?.deliveryToken).toBe(2)

    // The slow consumer still holds token 1 and must not overwrite the new claim.
    expect(
      await r.outbox.markDispatched(record.id, { now: at(2_100), token: first!.deliveryToken }),
    ).toBe(false)
    expect(
      await r.outbox.markRetry(record.id, {
        now: at(2_100),
        token: first!.deliveryToken,
        error: 'stale',
        retryAt: at(9_000),
      }),
    ).toBe(false)
    expect(
      await r.outbox.markDeadLetter(record.id, {
        now: at(2_100),
        token: first!.deliveryToken,
        error: 'stale',
      }),
    ).toBe(false)
    expect((await r.outbox.countByStatus('processing'))).toBe(1)
  })

  it('dead-letters within the claim lifetime', async () => {
    const r = await open()
    const record = await r.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-1',
      availableAt: T0,
    })
    const [claimed] = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    expect(
      await r.outbox.markDeadLetter(record.id, {
        now: T0,
        token: claimed!.deliveryToken,
        error: 'permanent',
      }),
    ).toBe(true)
    expect(await r.outbox.countByStatus('failed')).toBe(1)
  })

  it('does not claim records before availableAt', async () => {
    const r = await open()
    await r.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-1',
      availableAt: '2026-01-01T00:10:00.000Z',
    })
    expect(await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })).toHaveLength(0)
  })

  it('reports status counts and expired processing leases', async () => {
    const r = await open()
    await r.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })
    await r.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-2',
      availableAt: at(10_000),
    })
    await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })

    const stats = await r.outbox.stats(at(2_000))
    expect(stats).toEqual({
      pending: 1,
      processing: 1,
      dispatched: 0,
      deadLetter: 0,
      expiredProcessing: 1,
      oldestPendingAt: at(10_000),
    })
  })

  it('reports the oldest pending availableAt and ignores dispatched rows', async () => {
    const r = await open()
    expect((await r.outbox.stats(T0)).oldestPendingAt).toBeNull()

    await r.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })
    await r.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-2',
      availableAt: at(5_000),
    })
    expect((await r.outbox.stats(T0)).oldestPendingAt).toBe(T0)

    // Dispatch the oldest row; the lag must follow the next pending record.
    const [claimed] = await r.outbox.claim({ now: T0, limit: 1, leaseMs: 1_000 })
    expect(claimed?.idempotencyKey).toBe('k-1')
    expect(
      await r.outbox.markDispatched(claimed!.id, { now: T0, token: claimed!.deliveryToken }),
    ).toBe(true)

    const stats = await r.outbox.stats(T0)
    expect(stats.pending).toBe(1)
    expect(stats.dispatched).toBe(1)
    expect(stats.oldestPendingAt).toBe(at(5_000))

    // Nothing left pending => null, not a stale timestamp.
    const [rest] = await r.outbox.claim({ now: at(5_000), limit: 1, leaseMs: 1_000 })
    await r.outbox.markDispatched(rest!.id, { now: at(5_000), token: rest!.deliveryToken })
    expect((await r.outbox.stats(at(5_000))).oldestPendingAt).toBeNull()
  })
})

describe('OutboxStore across control-db handles', () => {
  it('claims a record exactly once when two handles race', async () => {
    const [first, second] = await openSharedFile()
    await first.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })

    const [a, b] = await Promise.all([
      first.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 }),
      second.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 }),
    ])

    expect(a.length + b.length).toBe(1)
    expect(await second.outbox.countByStatus('processing')).toBe(1)
  })

  it('rejects the losing handle after the other one reclaimed the row', async () => {
    const [first, second] = await openSharedFile()
    const record = await first.outbox.append({
      topic: 't',
      payload: {},
      idempotencyKey: 'k-1',
      availableAt: T0,
    })
    const [claimed] = await second.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })

    const [reclaimed] = await first.outbox.claim({ now: at(2_000), limit: 10, leaseMs: 1_000 })
    expect(reclaimed?.deliveryToken).toBe((claimed?.deliveryToken ?? 0) + 1)

    expect(
      await second.outbox.markDispatched(record.id, { now: at(2_100), token: claimed!.deliveryToken }),
    ).toBe(false)
    expect(await first.outbox.countByStatus('processing')).toBe(1)
  })
})
