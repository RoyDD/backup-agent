import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asTargetId } from '../../src/domain/ids'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { LeaseRecord, Repository } from '../../src/ports/repository'

const T0 = '2026-01-01T00:00:00.000Z'
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const target = asTargetId('pg-prod')

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
  const dir = mkdtempSync(join(tmpdir(), 'bk-lease-'))
  dirs.push(dir)
  const filename = join(dir, 'control.db')
  return [await open(filename), await open(filename)]
}

async function acquire(
  repo: Repository,
  owner: string,
  now: string,
  ttlMs = 1_000,
): Promise<LeaseRecord | null> {
  return repo.transaction((tx) => tx.leases.acquire({ targetId: target, owner, now, ttlMs }))
}

describe('LeaseStore', () => {
  it('grants one owner at a time', async () => {
    const r = await open()
    const first = await acquire(r, 'worker-a', T0)
    expect(first?.token).toBe(1)
    expect(first?.expiresAt).toBe(at(1_000))

    expect(await acquire(r, 'worker-b', at(500))).toBeNull()
  })

  it('refuses a re-acquire by the same owner while the lease is live', async () => {
    const r = await open()
    const first = await acquire(r, 'worker-a', T0)
    expect(first?.token).toBe(1)

    // Re-acquiring would hand out authority without advancing the fence.
    expect(await acquire(r, 'worker-a', at(500))).toBeNull()
    expect(await r.leases.currentFence(target)).toBe(1)
  })

  it('advances the fence when the same owner re-acquires after expiry', async () => {
    const r = await open()
    await acquire(r, 'worker-a', T0)
    const again = await acquire(r, 'worker-a', at(2_000))
    expect(again?.token).toBe(2)
    expect(await r.leases.currentFence(target)).toBe(2)
  })

  it('advances the fencing token after release', async () => {
    const r = await open()
    const first = await acquire(r, 'worker-a', T0)
    await r.leases.release({ targetId: target, owner: 'worker-a', token: first!.token })

    const second = await acquire(r, 'worker-b', at(600))
    expect(second?.token).toBe(2)
    expect(await r.leases.currentFence(target)).toBe(2)
  })

  it('advances the fence when an expired lease is taken over', async () => {
    const r = await open()
    await acquire(r, 'worker-a', T0)
    const taken = await acquire(r, 'worker-c', at(2_000))
    expect(taken?.token).toBe(2)
  })

  it('renews only with the matching owner and token', async () => {
    const r = await open()
    const lease = await acquire(r, 'worker-a', T0)
    expect(
      await r.leases.renew({ targetId: target, owner: 'worker-a', token: 999, now: at(500), ttlMs: 1_000 }),
    ).toBe(false)
    expect(
      await r.leases.renew({ targetId: target, owner: 'worker-a', token: lease!.token, now: at(500), ttlMs: 1_000 }),
    ).toBe(true)
    expect((await r.leases.get(target))?.expiresAt).toBe(at(1_500))
  })

  it('does not revive an expired lease', async () => {
    const r = await open()
    const lease = await acquire(r, 'worker-a', T0)

    const renewed = await r.leases.renew({
      targetId: target,
      owner: 'worker-a',
      token: lease!.token,
      now: at(2_000),
      ttlMs: 1_000,
    })

    expect(renewed).toBe(false)
    expect((await r.leases.get(target))?.expiresAt).toBe(at(1_000))
  })

  it('ignores a release with a stale token', async () => {
    const r = await open()
    const lease = await acquire(r, 'worker-a', T0)
    await r.leases.release({ targetId: target, owner: 'worker-a', token: lease!.token + 1 })
    expect(await r.leases.get(target)).not.toBeNull()
  })
})

describe('LeaseStore across control-db handles', () => {
  it('serializes acquisition so only one handle wins', async () => {
    const [first, second] = await openSharedFile()

    const a = await acquire(first, 'worker-a', T0, 10_000)
    const b = await acquire(second, 'worker-b', at(1), 10_000)

    expect(a?.token).toBe(1)
    expect(b).toBeNull()
    expect(await second.leases.currentFence(target)).toBe(1)
  })

  it('keeps the fence monotonic across handles after release', async () => {
    const [first, second] = await openSharedFile()

    const a = await acquire(first, 'worker-a', T0, 10_000)
    await first.leases.release({ targetId: target, owner: 'worker-a', token: a!.token })
    const b = await acquire(second, 'worker-b', at(1), 10_000)

    expect(b?.token).toBe(2)
    expect(await first.leases.currentFence(target)).toBe(2)
    // The second handle's lease is visible to the first handle as a live one.
    expect(await acquire(first, 'worker-c', at(2), 10_000)).toBeNull()
  })

  it('rejects a renewal from a superseded handle', async () => {
    const [first, second] = await openSharedFile()

    const a = await acquire(first, 'worker-a', T0, 1_000)
    const takeover = await acquire(second, 'worker-b', at(2_000), 10_000)
    expect(takeover?.token).toBe(2)

    expect(
      await first.leases.renew({
        targetId: target,
        owner: 'worker-a',
        token: a!.token,
        now: at(2_100),
        ttlMs: 1_000,
      }),
    ).toBe(false)
    expect(await first.leases.get(target)).toMatchObject({ owner: 'worker-b', token: 2 })
  })
})
