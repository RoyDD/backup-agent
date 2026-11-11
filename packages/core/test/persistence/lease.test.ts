import { afterEach, describe, expect, it } from 'vitest'

import { asTargetId } from '../../src/domain/ids'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { Repository } from '../../src/ports/repository'

const T0 = '2026-01-01T00:00:00.000Z'
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const target = asTargetId('pg-prod')

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

describe('LeaseStore', () => {
  it('grants one owner at a time', async () => {
    const r = await open()
    const first = await r.leases.acquire({ targetId: target, owner: 'worker-a', now: T0, ttlMs: 1_000 })
    expect(first?.token).toBe(1)
    expect(first?.expiresAt).toBe(at(1_000))

    expect(await r.leases.acquire({ targetId: target, owner: 'worker-b', now: at(500), ttlMs: 1_000 })).toBeNull()
  })

  it('lets the same owner re-acquire without advancing the fence', async () => {
    const r = await open()
    await r.leases.acquire({ targetId: target, owner: 'worker-a', now: T0, ttlMs: 1_000 })
    const again = await r.leases.acquire({ targetId: target, owner: 'worker-a', now: at(500), ttlMs: 1_000 })
    expect(again?.token).toBe(1)
    expect(await r.leases.currentFence(target)).toBe(1)
  })

  it('advances the fencing token after release', async () => {
    const r = await open()
    const first = await r.leases.acquire({ targetId: target, owner: 'worker-a', now: T0, ttlMs: 1_000 })
    await r.leases.release({ targetId: target, owner: 'worker-a', token: first!.token })

    const second = await r.leases.acquire({ targetId: target, owner: 'worker-b', now: at(600), ttlMs: 1_000 })
    expect(second?.token).toBe(2)
    expect(await r.leases.currentFence(target)).toBe(2)
  })

  it('advances the fence when an expired lease is taken over', async () => {
    const r = await open()
    await r.leases.acquire({ targetId: target, owner: 'worker-a', now: T0, ttlMs: 1_000 })
    const taken = await r.leases.acquire({ targetId: target, owner: 'worker-c', now: at(2_000), ttlMs: 1_000 })
    expect(taken?.token).toBe(2)
  })

  it('renews only with the matching owner and token', async () => {
    const r = await open()
    const lease = await r.leases.acquire({ targetId: target, owner: 'worker-a', now: T0, ttlMs: 1_000 })
    expect(
      await r.leases.renew({ targetId: target, owner: 'worker-a', token: 999, now: at(500), ttlMs: 1_000 }),
    ).toBe(false)
    expect(
      await r.leases.renew({ targetId: target, owner: 'worker-a', token: lease!.token, now: at(500), ttlMs: 1_000 }),
    ).toBe(true)
    expect((await r.leases.get(target))?.expiresAt).toBe(at(1_500))
  })

  it('ignores a release with a stale token', async () => {
    const r = await open()
    const lease = await r.leases.acquire({ targetId: target, owner: 'worker-a', now: T0, ttlMs: 1_000 })
    await r.leases.release({ targetId: target, owner: 'worker-a', token: lease!.token + 1 })
    expect(await r.leases.get(target)).not.toBeNull()
  })
})
