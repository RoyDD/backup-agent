import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { buildIndex, openIndex } from '../src/index/build'
import { runPipeline } from '../src/retrieval/pipeline'

const workspace = mkdtempSync(join(tmpdir(), 'bk-pipeline-'))
const corpusDir = join(workspace, 'corpus')
const dbPath = join(workspace, 'knowledge.sqlite')

mkdirSync(corpusDir, { recursive: true })
writeFileSync(
  join(corpusDir, 'doc.md'),
  `---
source_id: doc
title: Doc
url: https://example.invalid/doc
kind: md
version: test-1
license: MIT
---

## Archive failures

When archiving of WAL segments fails the point-in-time recovery window silently
stops growing, and operators only notice during a restore attempt. The failure
catalog entry E-08 covers the classic case.

## Failure catalog entry E-08

E-08 describes an archiver queue that never drains; the observable signature is a
climbing pg_stat_archiver.failed_count together with last_failed_wal.

## Unrelated topic

Compression settings and repository encryption keys are configured per stanza.
`,
  'utf8',
)

buildIndex({ dbPath, corpusDir, includeLocalDocs: false })

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('runPipeline', () => {
  it('single-round bm25 cannot reach a passage that shares no surface term with the question', async () => {
    const db = openIndex(dbPath)
    try {
      const { hits } = await runPipeline(db, 'archiving failures stop the recovery window', { mode: 'bm25', k: 3 })
      expect(hits.map((hit) => hit.headingPath)).toEqual(['Archive failures'])
    } finally {
      db.close()
    }
  })

  it('an expansion round reaches the second hop through a term found in the first passage', async () => {
    const db = openIndex(dbPath)
    try {
      const { hits, trace } = await runPipeline(db, 'archiving failures stop the recovery window', {
        mode: 'sag2',
        rounds: 1,
        k: 3,
      })
      expect(trace.rounds).toBe(1)
      const terms = trace.terms[0] ?? []
      expect(terms.some((term) => term.includes('e-08') || term.includes('catalog'))).toBe(true)
      expect(hits.map((hit) => hit.headingPath)).toContain('Failure catalog entry E-08')
    } finally {
      db.close()
    }
  })

  it('is deterministic: the same question always yields the same ranking', async () => {
    const db = openIndex(dbPath)
    try {
      const options = { mode: 'sag2' as const, rounds: 2, k: 3 }
      const first = (await runPipeline(db, 'archiver queue never drains', options)).hits.map((hit) => hit.passageId)
      const second = (await runPipeline(db, 'archiver queue never drains', options)).hits.map((hit) => hit.passageId)
      expect(second).toEqual(first)
    } finally {
      db.close()
    }
  })

  it('keeps expansion terms out of the pool when the question is already precise', async () => {
    const db = openIndex(dbPath)
    try {
      const { hits } = await runPipeline(db, 'repository encryption keys per stanza', { mode: 'sag2', rounds: 2, k: 3 })
      expect(hits[0]?.headingPath).toBe('Unrelated topic')
    } finally {
      db.close()
    }
  })
})
