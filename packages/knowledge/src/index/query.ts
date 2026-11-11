import type { DatabaseSync } from 'node:sqlite'

import { expandQuery } from '../text/aliases'
import { toMatchQuery } from '../text/tokenize'
import type { Hit } from '../types'

export interface SearchOptions {
  k?: number
  /** Restrict retrieval to these corpus source ids (e.g. one PostgreSQL version). */
  sources?: string[]
  /**
   * Rewrite the question through the domain alias dictionary before tokenizing.
   * Default: on — it is query-side only and never mutates the index.
   */
  expand?: boolean
}

interface HitRow {
  id: number
  source_id: string
  version: string
  heading_path: string
  ordinal: number
  text: string
  score: number
}

/**
 * Single-round BM25 retrieval — the baseline that any SAG2 expansion round must
 * beat. FTS5's `bm25()` returns negative scores where more negative is better, so
 * rows are ordered ascending.
 */
export function search(db: DatabaseSync, question: string, options: SearchOptions = {}): Hit[] {
  const expanded = expandQuery(question, { enabled: options.expand !== false })
  const match = toMatchQuery(expanded.query)
  if (match.length === 0) return []

  const k = options.k ?? 10
  const sources = options.sources ?? []
  const filter = sources.length > 0 ? ` AND p.source_id IN (${sources.map(() => '?').join(', ')})` : ''

  const sql = `
    SELECT p.id, p.source_id, p.version, p.heading_path, p.ordinal, p.text,
           bm25(passage_fts, 2.0, 1.0) AS score
    FROM passage_fts
    JOIN passage p ON p.id = passage_fts.rowid
    WHERE passage_fts MATCH ?${filter}
    ORDER BY score ASC
    LIMIT ?
  `

  let rows: HitRow[]
  try {
    rows = db.prepare(sql).all(match, ...sources, k) as unknown as HitRow[]
  } catch (error) {
    // A malformed MATCH expression must never take the caller down; retrieval is advisory.
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`retrieval failed (${message}); query=${match}`)
  }

  return rows.map((row) => ({
    passageId: row.id,
    sourceId: row.source_id,
    version: row.version,
    headingPath: row.heading_path,
    ordinal: row.ordinal,
    score: row.score,
    text: row.text,
  }))
}
