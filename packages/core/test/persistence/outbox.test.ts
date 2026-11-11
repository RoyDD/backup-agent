import { afterEach, describe, expect, it } from 'vitest'

import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { Repository } from '../../src/ports/repository'

const T0 = '2026-01-01T00:00:00.000Z'

let repo: Repository | undefined

afterEach(async () => {
  await repo?.close()
  repo = undefined
})

async function open(): Promise<Repository> {
  const created = await createSqliteRepository({ filename: ':memory:' })
  await created.migrate()
  repo = created
  return created
}

describe('OutboxStore', () => {
  it('deduplicates by idempotency key', async () => {
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
    expect(await r.outbox.countByStatus('pending')).toBe(1)
  })

  it('claims pending records and leases them', async () => {
    const r = await open()
    await r.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })

    const claimed = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('processing')
    expect(claimed[0]?.attempts).toBe(1)
    expect(claimed[0]?.leaseExpiresAt).toBe('2026-01-01T00:00:01.000Z')

    const again = await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })
    expect(again).toHaveLength(0)
  })

  it('reclaims a record after its lease expires', async () => {
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
  })

  it('marks dispatched and failed records', async () => {
    const r = await open()
    const record = await r.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })
    await r.outbox.markDispatched(record.id, T0)
    expect(await r.outbox.countByStatus('dispatched')).toBe(1)

    const second = await r.outbox.append({ topic: 't', payload: {}, idempotencyKey: 'k-2', availableAt: T0 })
    await r.outbox.markFailed(second.id, 'boom', '2026-01-01T00:05:00.000Z')
    expect(await r.outbox.countByStatus('pending')).toBe(1)
    const retry = await r.outbox.claim({ now: '2026-01-01T00:05:00.000Z', limit: 10, leaseMs: 1_000 })
    expect(retry.map((row) => row.id)).toEqual([second.id])
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
})
