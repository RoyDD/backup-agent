import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { buildIndex, openIndex } from '../src/index/build'
import { search } from '../src/index/query'

const workspace = mkdtempSync(join(tmpdir(), 'bk-knowledge-'))
const corpusDir = join(workspace, 'corpus')
const dbPath = join(workspace, 'knowledge.sqlite')

mkdirSync(corpusDir, { recursive: true })
writeFileSync(
  join(corpusDir, 'pg16-continuous-archiving.md'),
  `---
source_id: pg16-continuous-archiving
title: Continuous Archiving
url: https://example.invalid/pg16
kind: html
version: pg16
license: PostgreSQL License
---

## Continuous Archiving and Point-in-Time Recovery (PITR)

PostgreSQL maintains a write ahead log (WAL) in the pg_wal subdirectory. Archiving
requires setting archive_command so that completed WAL segments are copied to
durable storage.

## Setting up WAL archiving

Set archive_command to a shell command that copies the segment. The pg_stat_archiver
view reports failed_count and last_failed_wal so a stuck archive_command is visible.

## Recovery target settings

recovery_target_lsn stops replay at a specific LSN. recovery_target_time is an
alternative. The restore_command must be able to fetch every required segment.
`,
  'utf8',
)
writeFileSync(
  join(corpusDir, 'walg-postgresql.md'),
  `---
source_id: walg-postgresql
title: WAL-G PostgreSQL
url: https://example.invalid/walg
kind: md
version: walg-master
license: Apache-2.0
---

# WAL-G PostgreSQL

## backup-fetch

wal-g backup-fetch restores a base backup. Combined with wal-g wal-fetch it restores
an archived WAL stream for point-in-time recovery.
`,
  'utf8',
)

buildIndex({ dbPath, corpusDir, includeLocalDocs: false })

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('buildIndex + search', () => {
  it('records the chunking policy in meta so an index can be invalidated', () => {
    const db = openIndex(dbPath)
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'chunk_policy'").get() as { value: string }
      expect(row.value).toContain('table-row-split')
    } finally {
      db.close()
    }
  })

  it('ranks the passage that answers the question first', () => {
    const db = openIndex(dbPath)
    try {
      const hits = search(db, 'how does archive_command relate to pg_stat_archiver failed_count', { k: 3 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]?.text).toContain('pg_stat_archiver')
    } finally {
      db.close()
    }
  })

  it('retrieves with a chinese query against english passages via technical terms', () => {
    const db = openIndex(dbPath)
    try {
      const hits = search(db, 'recovery_target_lsn 时间点恢复', { k: 3 })
      expect(hits[0]?.text).toContain('recovery_target_lsn')
    } finally {
      db.close()
    }
  })

  it('honours a source filter', () => {
    const db = openIndex(dbPath)
    try {
      const hits = search(db, 'restore_command base backup', { k: 5, sources: ['walg-postgresql'] })
      expect(hits.every((hit) => hit.sourceId === 'walg-postgresql')).toBe(true)
    } finally {
      db.close()
    }
  })
})
