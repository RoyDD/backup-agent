import type { DatabaseSync } from 'node:sqlite'

/**
 * Corpus term statistics.
 *
 * SAG2's term selection needs term rarity, and BM25 inside FTS5 keeps its own
 * statistics we cannot read back. Building `term_df` at index time gives the
 * pipeline the same view without recomputing anything per query.
 */
export class CorpusStats {
  private readonly df: Map<string, number>
  readonly total: number

  constructor(db: DatabaseSync) {
    this.df = new Map()
    const rows = db.prepare('SELECT term, df FROM term_df').all() as Array<{ term: string; df: number }>
    for (const row of rows) this.df.set(row.term, row.df)
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'passages'").get() as { value: string } | undefined
    this.total = meta ? Number(meta.value) : 0
  }

  documentFrequency(term: string): number {
    return this.df.get(term) ?? 0
  }

  /** BM25-style idf, always positive so a single wrong term cannot dominate. */
  idf(term: string): number {
    const df = this.documentFrequency(term)
    return Math.log(1 + (this.total - df + 0.5) / (df + 0.5))
  }

  /**
   * Terms that appear in a large share of passages carry no discriminative signal.
   * The absolute floor keeps tiny corpora (tests, single-topic indexes) usable:
   * in a three-passage index every term looks "common" by ratio alone.
   */
  isCommon(term: string, ratio = 0.15): boolean {
    if (this.total === 0) return false
    const df = this.documentFrequency(term)
    return df > 5 && df / this.total > ratio
  }
}

/** Tokens that name something concrete: identifiers, options, view/parameter names. */
export function isIdentifier(token: string): boolean {
  return /[_./-]/.test(token) || /^[a-z]+[0-9]+$/.test(token)
}
