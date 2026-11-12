import { afterEach, describe, expect, it } from 'vitest'

import { asArtifactId, asTargetId } from '../../src/domain/ids'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { ArtifactRecord, Repository } from '../../src/ports/repository'

const NOW = '2026-02-01T00:00:00.000Z'
const LATER = '2026-02-02T00:00:00.000Z'

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

function record(id: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: asArtifactId(id),
    planId: null,
    targetId: asTargetId('pg-dev'),
    provider: 'native-logical',
    kind: 'full',
    parentId: null,
    path: `/backups/${id}.dump`,
    sizeBytes: 42,
    checksum: 'sha256:abc',
    verifiedLevel: null,
    verifiedAt: null,
    protected: false,
    createdAt: NOW,
    ...overrides,
  }
}

describe('artifact lifecycle', () => {
  it('defaults new rows to live and reads history only when asked', async () => {
    const r = await open()
    await r.artifacts.insert(record('art_live'))
    await r.artifacts.insert(
      record('art_gone', { lifecycleState: 'tombstoned', tombstonedAt: LATER }),
    )

    expect((await r.artifacts.list({})).map((row) => row.id)).toEqual(['art_live'])
    expect((await r.artifacts.list({ lifecycle: 'live' })).map((row) => row.id)).toEqual([
      'art_live',
    ])
    expect((await r.artifacts.list({ lifecycle: 'tombstoned' })).map((row) => row.id)).toEqual([
      'art_gone',
    ])
    expect(await r.artifacts.list({ lifecycle: 'any' })).toHaveLength(2)

    // `get` is an identity lookup and keeps resolving tombstoned rows.
    const gone = await r.artifacts.get(asArtifactId('art_gone'))
    expect(gone?.path).toBe('/backups/art_gone.dump')
    expect(gone?.lifecycleState).toBe('tombstoned')
    expect(gone?.tombstonedAt).toBe(LATER)
  })

  it('tombstones atomically and reports already-tombstoned and missing ids', async () => {
    const r = await open()
    await r.artifacts.insert(record('art_a'))
    await r.artifacts.insert(record('art_b'))
    await r.artifacts.insert(
      record('art_c', { lifecycleState: 'tombstoned', tombstonedAt: NOW }),
    )

    const ids = ['art_a', 'art_b', 'art_c', 'art_missing'].map((id) => asArtifactId(id))
    const first = await r.artifacts.tombstone(ids, LATER)
    expect(first.tombstoned).toEqual([asArtifactId('art_a'), asArtifactId('art_b')])
    expect(first.alreadyTombstoned).toEqual([asArtifactId('art_c')])
    expect(first.missing).toEqual([asArtifactId('art_missing')])

    const second = await r.artifacts.tombstone(ids, LATER)
    expect(second.tombstoned).toEqual([])
    expect(second.alreadyTombstoned).toEqual([
      asArtifactId('art_a'),
      asArtifactId('art_b'),
      asArtifactId('art_c'),
    ])

    // Rows are retained: tombstoning is not deletion.
    expect(await r.artifacts.list({ lifecycle: 'any' })).toHaveLength(3)
    const a = await r.artifacts.get(asArtifactId('art_a'))
    expect(a?.tombstonedAt).toBe(LATER)
    expect(a?.checksum).toBe('sha256:abc')
    expect(a?.path).toBe('/backups/art_a.dump')
  })
})
