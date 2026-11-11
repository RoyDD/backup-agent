import type { DatabaseSync } from 'node:sqlite'

import { search } from '../index/query'
import { expandQuery } from '../text/aliases'
import type { Hit } from '../types'
import { bm25Range, coveredTerms, mmrRank, questionTerms, scorePassage, selectionScore, type Scored } from './score'
import { CorpusStats } from './stats'
import { extractExpansionTerms } from './terms'

/**
 * Retrieval pipelines.
 *
 * - `bm25`: single-round lexical baseline.
 * - `sag2`: BM25 → score → seed → expansion terms → retrieve → re-score, repeated
 *   `rounds` times, then MMR over the whole pool. The re-score inside the loop is
 *   the point: SAG2's own ablation shows lexical expansion with a single final
 *   scoring round stalls at 61.34% on MuSiQue versus 86.62% for the full loop.
 * - `expand-only`: the control. Same expansion terms, gathered once, one final
 *   scoring pass and no diversification.
 */
export type RetrievalMode = 'bm25' | 'sag2' | 'expand-only'

export interface PipelineOptions {
  mode?: RetrievalMode
  k?: number
  /** Lexical candidates per retrieval call. */
  candidateK?: number
  /** Passages used as evidence seeds per round. */
  seedK?: number
  /** Expansion terms per round. */
  termsPerRound?: number
  /** Expansion rounds after the initial retrieval (SAG2 default: 2). */
  rounds?: number
  expandAliases?: boolean
  diversify?: boolean
  lambda?: number
  sources?: string[]
}

export interface PipelineTrace {
  mode: RetrievalMode
  rounds: number
  candidates: number
  terms: string[][]
  ms: number
}

interface PoolEntry {
  hit: Hit
  bm25?: number
}

const DEFAULTS = {
  candidateK: 100,
  seedK: 10,
  termsPerRound: 20,
  rounds: 2,
  lambda: 0.7,
  perTermK: 20,
}

function toScorable(entry: PoolEntry): { id: number; text: string; headingPath: string; bm25?: number } {
  return {
    id: entry.hit.passageId,
    text: entry.hit.text,
    headingPath: entry.hit.headingPath,
    ...(entry.bm25 === undefined ? {} : { bm25: entry.bm25 }),
  }
}

export function runPipeline(
  db: DatabaseSync,
  question: string,
  options: PipelineOptions = {},
): { hits: Hit[]; trace: PipelineTrace } {
  const started = Date.now()
  const mode = options.mode ?? 'sag2'
  const k = options.k ?? 10
  const candidateK = options.candidateK ?? DEFAULTS.candidateK
  const seedK = options.seedK ?? DEFAULTS.seedK
  const termsPerRound = options.termsPerRound ?? DEFAULTS.termsPerRound
  const rounds = mode === 'sag2' ? (options.rounds ?? DEFAULTS.rounds) : 0
  const sources = options.sources

  const expanded = expandQuery(question, { enabled: options.expandAliases !== false })
  const stats = mode === 'bm25' ? null : new CorpusStats(db)
  const qTerms = stats ? questionTerms(question, stats) : null

  const pool = new Map<number, PoolEntry>()
  const addHits = (hits: Hit[]): void => {
    for (const hit of hits) {
      if (pool.has(hit.passageId)) continue
      pool.set(hit.passageId, { hit, bm25: hit.score })
    }
  }

  addHits(search(db, expanded.query, { k: candidateK, expand: false, ...(sources ? { sources } : {}) }))

  if (mode === 'bm25' || !stats || !qTerms) {
    return {
      hits: [...pool.values()].map((entry) => entry.hit).slice(0, k),
      trace: { mode: 'bm25', rounds: 0, candidates: pool.size, terms: [], ms: Date.now() - started },
    }
  }

  const scoreAll = (context: Set<string>, order: 'evidence' | 'selection' = 'evidence'): Scored[] => {
    const entries = [...pool.values()]
    const range = bm25Range(entries.map((entry) => ({ bm25: entry.bm25 })))
    const key = order === 'selection' ? selectionScore : (entry: Scored) => entry.evidence
    return entries
      .map((entry) => scorePassage(toScorable(entry), qTerms, stats, { context, bm25Range: range }))
      .sort((a, b) => key(b) - key(a) || a.id - b.id)
  }

  const trace: PipelineTrace = { mode, rounds: 0, candidates: 0, terms: [], ms: 0 }

  if (mode === 'expand-only') {
    // Control: seeds from lexical order only, one final scoring pass, no reselection.
    const seedScored = scoreAll(new Set())
    const terms = extractExpansionTerms(seedScored.slice(0, seedK), qTerms, stats, new Set(), termsPerRound)
    trace.terms.push(terms)
    for (const term of terms) {
      addHits(search(db, term, { k: DEFAULTS.perTermK, expand: false, ...(sources ? { sources } : {}) }))
    }
    const ranked = scoreAll(new Set())
    trace.candidates = pool.size
    trace.ms = Date.now() - started
    return { hits: ranked.slice(0, k).map((entry) => toHit(entry, pool)), trace }
  }

  const usedTerms = new Set<string>()
  let seeds = scoreAll(new Set()).slice(0, seedK)

  for (let round = 0; round < rounds; round += 1) {
    const context = coveredTerms(seeds, qTerms)
    const terms = extractExpansionTerms(seeds, qTerms, stats, usedTerms, termsPerRound)
    trace.terms.push(terms)
    if (terms.length === 0) break
    for (const term of terms) usedTerms.add(term)

    const perTerm = terms.map((term) =>
      search(db, term, { k: DEFAULTS.perTermK, expand: false, ...(sources ? { sources } : {}) }),
    )
    // Interleave by rank so no single term's tail floods the pool.
    const maxLength = Math.max(0, ...perTerm.map((hits) => hits.length))
    for (let rank = 0; rank < maxLength; rank += 1) {
      for (const hits of perTerm) {
        const hit = hits[rank]
        if (hit) addHits([hit])
      }
    }

    // Seeds for the next round reward evidence the current context does not cover.
    seeds = scoreAll(context, 'selection').slice(0, seedK)
    trace.rounds = round + 1
  }

  const ranked = scoreAll(coveredTerms(seeds, qTerms))
  trace.candidates = pool.size
  trace.ms = Date.now() - started

  // Off by default: in this corpus gold evidence is often several passages of the
  // same section, so MMR pushes correct near-duplicates out of the top-k
  // (measured: confusable R@10 48.26% -> 28.17%).
  const diversify = options.diversify === true
  const final = diversify ? mmrRank(ranked, k, options.lambda ?? DEFAULTS.lambda) : ranked.slice(0, k)
  return { hits: final.map((entry) => toHit(entry, pool)), trace }
}

/** Re-attach corpus metadata (source, version, ordinal) and expose the evidence score. */
function toHit(scored: Scored, pool: Map<number, PoolEntry>): Hit {
  const original = pool.get(scored.id)?.hit
  return {
    passageId: scored.id,
    sourceId: original?.sourceId ?? '',
    version: original?.version ?? '',
    headingPath: scored.headingPath,
    ordinal: original?.ordinal ?? 0,
    score: scored.evidence,
    text: scored.text,
  }
}
