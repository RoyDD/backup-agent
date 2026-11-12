/**
 * Domain types for the PG backup/recovery evidence base.
 *
 * The knowledge base follows the SAG2 shape: original passages are indexed
 * lexically (SQLite FTS5/BM25), and association between passages is discovered
 * at query time rather than stored as a graph. Nothing here may depend on a
 * model call: every stage must be deterministic and offline-reproducible.
 */

export interface CorpusSource {
  sourceId: string
  /** Where the text came from: pinned upstream snapshot, llm-wiki export, or a project doc. */
  origin?: 'snapshot' | 'wiki' | 'local'
  title: string
  url: string
  kind: 'html' | 'md'
  version: string
  license: string
  fetchedAt?: string
  sha256?: string
  /** Raw markdown body (frontmatter already stripped). */
  body: string
}

export interface Chunk {
  sourceId: string
  version: string
  headingPath: string
  ordinal: number
  text: string
  chars: number
}

export interface Passage {
  id: number
  sourceId: string
  version: string
  headingPath: string
  ordinal: number
  text: string
  chars: number
}

export interface Hit {
  passageId: number
  sourceId: string
  version: string
  headingPath: string
  ordinal: number
  score: number
  text: string
}

/** A gold evidence reference, resolved against the indexed passages at eval time. */
export interface GoldRef {
  source: string
  /** Case-insensitive substring that must appear in the passage; the passage set is resolved from it. */
  contains?: string
  /** Case-insensitive substring that must appear in the passage's heading path. */
  heading?: string
  /** Direct passage selector: `source#ordinal` (0-based within the source). */
  passage?: string
}

export type QuestionKind = 'fact' | 'multihop' | 'troubleshoot' | 'confusable'

export type QuestionLang = 'zh' | 'en'

export interface EvalQuestion {
  id: string
  kind: QuestionKind
  /** Language the question is phrased in; the corpus itself is overwhelmingly English. */
  lang?: QuestionLang
  question: string
  gold: GoldRef[]
}

export interface ResolvedGold extends GoldRef {
  passageIds: number[]
}

export interface QuestionResult {
  id: string
  kind: QuestionKind
  lang: QuestionLang
  question: string
  gold: ResolvedGold[]
  hits: number[]
  recallAt: Record<string, number>
  allEvidenceAt: Record<string, boolean>
  mrrAt10: number
}

export interface EvalSummary {
  questions: number
  kinds: Record<string, number>
  unresolvedGold: Array<{ id: string; ref: GoldRef }>
  recallAt: Record<string, number>
  allEvidenceAt: Record<string, boolean>
  mrrAt10: number
  byKind: Record<string, { questions: number; recallAt: Record<string, number>; allEvidenceAt: Record<string, boolean> }>
  byLang: Record<string, { questions: number; recallAt: Record<string, number>; allEvidenceAt: Record<string, boolean> }>
  latency: { mean: number; p50: number; p95: number }
  settings: Record<string, unknown>
}
