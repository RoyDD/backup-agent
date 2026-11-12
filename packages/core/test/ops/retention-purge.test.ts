import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asArtifactId, asTargetId } from '../../src/domain/ids'
import type { ArtifactRecord } from '../../src/ports/repository'
import type { Storage } from '../../src/ports/storage'
import { FsStorage } from '../../src/storage/fs-storage'
import { applyPurge, planPurge } from '../../src/ops/retention-purge'

const NOW = '2026-03-01T00:00:00.000Z'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempStorage(): FsStorage {
  const root = mkdtempSync(join(tmpdir(), 'bk-purge-'))
  roots.push(root)
  return new FsStorage({ root })
}

/** `days` before `NOW`, as an ISO timestamp. */
function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString()
}

function artifact(id: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: asArtifactId(id),
    planId: null,
    targetId: asTargetId('pg-dev'),
    provider: 'native-logical',
    kind: 'full',
    parentId: null,
    path: `backups/${id}.dump`,
    sizeBytes: 100,
    checksum: null,
    verifiedLevel: null,
    verifiedAt: null,
    protected: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lifecycleState: 'tombstoned',
    tombstonedAt: daysAgo(30),
    ...overrides,
  }
}

/** Paths are object keys when relative; an absolute path is outside storage. */
function keyOf(record: ArtifactRecord): string | null {
  return record.path.startsWith('/') ? null : record.path
}

function onlyPlan(artifacts: readonly ArtifactRecord[], graceDays?: number) {
  return planPurge({ artifacts, now: NOW, keyOf, ...(graceDays === undefined ? {} : { graceDays }) })
}

describe('planPurge', () => {
  it('selects a tombstoned managed artifact past grace', async () => {
    const storage = tempStorage()
    await storage.put('backups/old.dump', 'old bytes')
    await storage.put('backups/live.dump', 'live bytes')

    const plan = onlyPlan([
      artifact('old'),
      artifact('live', { lifecycleState: 'live', tombstonedAt: null }),
    ])

    expect(plan.candidates).toEqual([
      { id: asArtifactId('old'), key: 'backups/old.dump', path: 'backups/old.dump', provider: 'native-logical' },
    ])
    expect(plan.skipped).toEqual([{ id: asArtifactId('live'), reason: 'not-tombstoned' }])
  })

  it('skips provider-owned and unknown providers even when tombstoned and old', () => {
    const plan = onlyPlan([
      artifact('pgbr', { provider: 'pgbackrest' }),
      artifact('walg', { provider: 'walg' }),
      artifact('mystery', { provider: 'someone-elses-tool' }),
    ])

    expect(plan.candidates).toEqual([])
    expect(plan.skipped).toEqual([
      { id: asArtifactId('mystery'), reason: 'unknown-provider', detail: 'someone-elses-tool' },
      { id: asArtifactId('pgbr'), reason: 'provider-owned', detail: 'pgbackrest' },
      { id: asArtifactId('walg'), reason: 'provider-owned', detail: 'walg' },
    ])
  })

  it('skips tombstones within the grace window and unparseable timestamps', () => {
    const plan = onlyPlan(
      [
        artifact('fresh', { tombstonedAt: daysAgo(2) }),
        artifact('boundary', { tombstonedAt: daysAgo(7) }),
        artifact('garbled', { tombstonedAt: 'not-a-timestamp' }),
        artifact('absent', { tombstonedAt: null }),
      ],
      7,
    )

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual([asArtifactId('boundary')])
    expect(plan.skipped.map((skip) => [skip.id, skip.reason])).toEqual([
      [asArtifactId('fresh'), 'within-grace'],
      [asArtifactId('absent'), 'within-grace'],
      [asArtifactId('garbled'), 'within-grace'],
    ])
  })

  it('respects a custom grace period', () => {
    const artifacts = [artifact('two-days', { tombstonedAt: daysAgo(2) })]
    expect(onlyPlan(artifacts, 1).candidates.map((c) => c.id)).toEqual([asArtifactId('two-days')])
    expect(onlyPlan(artifacts, 3).candidates).toEqual([])
  })

  it('skips a tombstone that a live artifact still depends on', () => {
    const parent = artifact('parent')
    const liveChild = artifact('child', {
      lifecycleState: 'live',
      tombstonedAt: null,
      parentId: asArtifactId('parent'),
      kind: 'incremental',
    })
    const deadChild = artifact('dead-child', { parentId: asArtifactId('parent') })

    expect(onlyPlan([parent, liveChild, deadChild]).skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: asArtifactId('parent'), reason: 'has-live-child' }),
      ]),
    )
    // The tombstoned child is not a live dependency: the parent stays blocked
    // only because of the live child, and the child itself is purgeable.
    const withoutLive = onlyPlan([parent, deadChild])
    expect(withoutLive.candidates.map((c) => c.id)).toEqual([
      asArtifactId('dead-child'),
      asArtifactId('parent'),
    ])
  })

  it('skips paths outside storage and empty paths', () => {
    const plan = onlyPlan([
      artifact('outside', { path: '/var/lib/postgresql/elsewhere.dump' }),
      artifact('empty', { path: '' }),
      artifact('blank', { path: '   ' }),
    ])

    expect(plan.candidates).toEqual([])
    expect(plan.skipped.map((skip) => [skip.id, skip.reason])).toEqual([
      [asArtifactId('blank'), 'missing-path'],
      [asArtifactId('empty'), 'missing-path'],
      [asArtifactId('outside'), 'outside-storage'],
    ])
  })

  it('orders equally old tombstones by id ascending', () => {
    const stamped = daysAgo(10)
    const plan = onlyPlan([
      artifact('zeta', { tombstonedAt: stamped }),
      artifact('alpha', { tombstonedAt: stamped }),
      artifact('older', { tombstonedAt: daysAgo(20) }),
    ])

    expect(plan.candidates.map((c) => c.id)).toEqual([
      asArtifactId('older'),
      asArtifactId('alpha'),
      asArtifactId('zeta'),
    ])
  })
})

describe('applyPurge', () => {
  it('deletes exactly the planned objects and leaves live files intact', async () => {
    const storage = tempStorage()
    await storage.put('backups/old.dump', 'old bytes')
    await storage.put('backups/live.dump', 'live bytes')

    const plan = onlyPlan([
      artifact('old'),
      artifact('live', { lifecycleState: 'live', tombstonedAt: null }),
    ])
    const report = await applyPurge(storage, plan)

    expect(report).toEqual({ purged: [asArtifactId('old')], missing: [], failed: [] })
    expect(await storage.stat('backups/old.dump')).toBeNull()
    expect(new TextDecoder().decode(await storage.get('backups/live.dump'))).toBe('live bytes')
  })

  it('reports an already-deleted object under missing, never as an error', async () => {
    const storage = tempStorage()
    await storage.put('backups/old.dump', 'old bytes')
    const plan = onlyPlan([artifact('old')])

    const first = await applyPurge(storage, plan)
    const second = await applyPurge(storage, plan)

    expect(first.purged).toEqual([asArtifactId('old')])
    expect(second).toEqual({ purged: [], missing: [asArtifactId('old')], failed: [] })
    expect(await storage.stat('backups/old.dump')).toBeNull()
  })

  it('records a throwing delete under failed and keeps purging the rest', async () => {
    const inner = tempStorage()
    await inner.put('backups/a.dump', 'a')
    await inner.put('backups/b.dump', 'b')
    await inner.put('backups/c.dump', 'c')

    const storage = storageThrowingFor(inner, ['backups/b.dump'])
    const report = await applyPurge(storage, onlyPlan([artifact('a'), artifact('b'), artifact('c')]))

    expect(report.purged).toEqual([asArtifactId('a'), asArtifactId('c')])
    expect(report.failed).toEqual([
      { id: asArtifactId('b'), error: 'simulated delete failure for backups/b.dump' },
    ])
    expect(report.missing).toEqual([])
    expect(await inner.stat('backups/a.dump')).toBeNull()
    expect(await inner.stat('backups/c.dump')).toBeNull()
    // The failing object survives: the report must not claim otherwise.
    expect(await inner.stat('backups/b.dump')).not.toBeNull()
  })
})

function storageThrowingFor(inner: Storage, badKeys: readonly string[]): Storage {
  return {
    id: inner.id,
    put: (key, data, options) => inner.put(key, data, options),
    get: (key) => inner.get(key),
    stat: (key) => inner.stat(key),
    list: (prefix) => inner.list(prefix),
    delete: async (key) => {
      if (badKeys.includes(key)) throw new Error(`simulated delete failure for ${key}`)
      return inner.delete(key)
    },
  }
}
