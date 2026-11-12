import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asArtifactId, asTargetId } from '../../src/domain/ids'
import type { ArtifactRecord } from '../../src/ports/repository'
import type { Storage, StorageStat } from '../../src/ports/storage'
import { FsStorage } from '../../src/storage/fs-storage'
import { applyOrphanGc, planOrphanGc } from '../../src/ops/orphan-gc'

const NOW = '2026-03-01T00:00:00.000Z'
/** Before `NOW - 7d`: eligible. */
const OLD = new Date('2026-02-01T00:00:00.000Z')
/** After `NOW - 7d`: inside the grace window. */
const FRESH = new Date('2026-02-28T00:00:00.000Z')

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempStorage(): { storage: FsStorage; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'bk-orphan-gc-'))
  roots.push(root)
  return { storage: new FsStorage({ root }), root }
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
    lifecycleState: 'live',
    tombstonedAt: null,
    ...overrides,
  }
}

function keyOf(record: ArtifactRecord): string | null {
  return record.path.startsWith('/') ? null : record.path
}

function stat(key: string, modifiedAt: string | null, bytes = 10): StorageStat {
  return { key, bytes, digest: null, modifiedAt }
}

describe('planOrphanGc', () => {
  it('plans only old unreferenced objects and accounts for the rest', async () => {
    const { storage, root } = tempStorage()
    await storage.put('backups/orphan-old.dump', 'orphan old')
    await storage.put('backups/orphan-fresh.dump', 'orphan fresh')
    await storage.put('backups/referenced.dump', 'referenced')
    utimesSync(join(root, 'backups', 'orphan-old.dump'), OLD, OLD)
    utimesSync(join(root, 'backups', 'orphan-fresh.dump'), FRESH, FRESH)

    const objects = await storage.list()
    const plan = planOrphanGc({
      objects,
      artifacts: [artifact('referenced')],
      now: NOW,
      keyOf,
    })

    expect(plan.delete).toEqual([
      { key: 'backups/orphan-old.dump', bytes: 'orphan old'.length, modifiedAt: OLD.toISOString() },
    ])
    expect(plan.referenced).toBe(1)
    expect(plan.withinGrace).toBe(1)
    expect(plan.unknownAge).toBe(0)
  })

  it('treats a tombstoned row as a reference so GC cannot race the purge phase', () => {
    const plan = planOrphanGc({
      objects: [stat('backups/old.dump', OLD.toISOString())],
      artifacts: [artifact('old', { lifecycleState: 'tombstoned', tombstonedAt: '2026-01-01T00:00:00.000Z' })],
      now: NOW,
      keyOf,
    })

    expect(plan.delete).toEqual([])
    expect(plan.referenced).toBe(1)
  })

  it('keeps objects whose age cannot be established', () => {
    const plan = planOrphanGc({
      objects: [
        stat('backups/no-mtime.dump', null),
        stat('backups/garbled.dump', 'not-a-timestamp'),
        stat('backups/too-old.dump', OLD.toISOString()),
      ],
      artifacts: [],
      now: NOW,
      keyOf,
    })

    expect(plan.delete.map((candidate) => candidate.key)).toEqual(['backups/too-old.dump'])
    expect(plan.unknownAge).toBe(2)
    expect(plan.withinGrace).toBe(0)
    expect(plan.referenced).toBe(0)
  })

  it('honours a custom grace period', () => {
    // Ten days old: inside a 20-day grace, outside a 5-day grace.
    const objects = [stat('backups/ten-days.dump', '2026-02-19T00:00:00.000Z')]
    expect(
      planOrphanGc({ objects, artifacts: [], now: NOW, graceDays: 20, keyOf }).delete,
    ).toEqual([])
    expect(
      planOrphanGc({ objects, artifacts: [], now: NOW, graceDays: 5, keyOf }).delete.map((c) => c.key),
    ).toEqual(['backups/ten-days.dump'])
  })

  it('orders candidates by key', () => {
    const objects = [
      stat('backups/zeta.dump', OLD.toISOString()),
      stat('backups/alpha.dump', OLD.toISOString()),
    ]
    expect(
      planOrphanGc({ objects, artifacts: [], now: NOW, keyOf }).delete.map((c) => c.key),
    ).toEqual(['backups/alpha.dump', 'backups/zeta.dump'])
  })
})

describe('applyOrphanGc', () => {
  it('deletes planned orphans, keeps fresh and referenced objects, and is a no-op on re-run', async () => {
    const { storage, root } = tempStorage()
    await storage.put('backups/orphan-old.dump', 'orphan old')
    await storage.put('backups/orphan-fresh.dump', 'orphan fresh')
    await storage.put('backups/referenced.dump', 'referenced')
    utimesSync(join(root, 'backups', 'orphan-old.dump'), OLD, OLD)
    utimesSync(join(root, 'backups', 'orphan-fresh.dump'), FRESH, FRESH)

    const artifacts = [artifact('referenced')]
    const first = planOrphanGc({ objects: await storage.list(), artifacts, now: NOW, keyOf })
    const report = await applyOrphanGc(storage, first)

    expect(report).toEqual({ deleted: ['backups/orphan-old.dump'], failed: [] })
    expect(await storage.stat('backups/orphan-old.dump')).toBeNull()
    expect(await storage.stat('backups/orphan-fresh.dump')).not.toBeNull()
    expect(new TextDecoder().decode(await storage.get('backups/referenced.dump'))).toBe('referenced')

    const second = planOrphanGc({ objects: await storage.list(), artifacts, now: NOW, keyOf })
    expect(second.delete).toEqual([])
    expect(await applyOrphanGc(storage, second)).toEqual({ deleted: [], failed: [] })
  })

  it('records a failing delete and keeps going', async () => {
    const { storage, root } = tempStorage()
    await storage.put('backups/a.dump', 'a')
    await storage.put('backups/b.dump', 'b')
    utimesSync(join(root, 'backups', 'a.dump'), OLD, OLD)
    utimesSync(join(root, 'backups', 'b.dump'), OLD, OLD)

    const plan = planOrphanGc({ objects: await storage.list(), artifacts: [], now: NOW, keyOf })
    const flaky: Storage = {
      id: storage.id,
      put: storage.put.bind(storage),
      get: storage.get.bind(storage),
      stat: storage.stat.bind(storage),
      list: storage.list.bind(storage),
      delete: async (key: string): Promise<boolean> => {
        if (key === 'backups/a.dump') throw new Error(`simulated delete failure for ${key}`)
        return storage.delete(key)
      },
    }

    const report = await applyOrphanGc(flaky, plan)

    expect(report.deleted).toEqual(['backups/b.dump'])
    expect(report.failed).toEqual([
      { key: 'backups/a.dump', error: 'simulated delete failure for backups/a.dump' },
    ])
    expect(await storage.stat('backups/a.dump')).not.toBeNull()
    expect(await storage.stat('backups/b.dump')).toBeNull()
  })
})
