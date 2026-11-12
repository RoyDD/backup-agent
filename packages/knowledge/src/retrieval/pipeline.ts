import type { DatabaseSync } from 'node:sqlite'

import { search } from '../index/query'
import { lexicalScorer, selectionValue, type ScorerPort } from '../ports/scorer'
import { expandQuery } from '../text/aliases'
import type { Hit } from '../types'
import {
  bm25Range,
  coveredTerms,
  mmrRank,
  questionTerms,
  scorePassage,
  type Scored,
} from './score'
import { CorpusStats } from './stats'
import { extractExpansionTerms } from './terms'

/**
 * Retrieval pipelines.
 *
 * - `bm25`: single-round lexical baseline.
 * - `sag2`: BM25 → score → seed → expansion terms → retrieve → re-score, repeated
 *   `rounds` times. The re-score inside the loop is the point: SAG2's own ablation
 *   shows lexical expansion with a single final scoring round stalls at 61.34% on
 *   MuSiQue versus 86.62% for the full loop.
 * - `expand-only`: the control. Same expansion terms, gathered once, one final
 *   scoring pass and no diversification.
 *
 * The scorer is a port (`ports/scorer.ts`): `lexical` by default, an external
 * command or an HTTP endpoint when a semantic reranker is available. Swapping it
 * must not change the loop — only the ranking it produces.
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
  /** Scoring backend; defaults to the deterministic lexical blend. */
  scorer?: ScorerPort
  /**
   * Cap on how many candidates an external scorer sees per round, taken from the
   * lexical ranking. Candidates outside the window become ineligible for the
   * final top-k, so a remote scorer is never charged for passages that cannot
   * rank anyway. Unset = score the whole pool.
   */
  scorerWindow?: number
}

export interface PipelineTrace {
  mode: RetrievalMode
  scorer: string
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

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export async function runPipeline(
  db: DatabaseSync,
  question: string,
  options: PipelineOptions = {},
): Promise<{ hits: Hit[]; trace: PipelineTrace }> {
  const started = Date.now()
  const mode = options.mode ?? 'sag2'
  const k = options.k ?? 10
  const candidateK = options.candidateK ?? DEFAULTS.candidateK
  const seedK = options.seedK ?? DEFAULTS.seedK
  const termsPerRound = options.termsPerRound ?? DEFAULTS.termsPerRound
  const rounds = mode === 'sag2' ? (options.rounds ?? DEFAULTS.rounds) : 0
  const sources = options.sources
  const scorer = options.scorer ?? lexicalScorer

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

  addHits(await search(db, expanded.query, { k: candidateK, expand: false, ...(sources ? { sources } : {}) }))

  if (mode === 'bm25' || !stats || !qTerms) {
    return {
      hits: [...pool.values()].map((entry) => entry.hit).slice(0, k),
      trace: { mode: 'bm25', scorer: scorer.id, rounds: 0, candidates: pool.size, terms: [], ms: Date.now() - started },
    }
  }

  const statsPort = stats
  const terms = qTerms

  const scoreAll = async (context: Set<string>, order: 'evidence' | 'selection' = 'evidence'): Promise<Scored[]> => {
    const entries = [...pool.values()]
    const range = bm25Range(entries.map((entry) => ({ bm25: entry.bm25 })))
    let scored = entries.map((entry) =>
      scorePassage(toScorable(entry), terms, statsPort, { context, bm25Range: range }),
    )

    if (scorer.id !== lexicalScorer.id) {
      const window = options.scorerWindow
      let eligible = scored
      if (window !== undefined && window > 0 && scored.length > window) {
        eligible = [...scored].sort((a, b) => b.evidence - a.evidence || a.id - b.id).slice(0, window)
        const inWindow = new Set(eligible.map((candidate) => candidate.id))
        scored = scored.map((candidate) => (inWindow.has(candidate.id) ? candidate : { ...candidate, evidence: -1 }))
      }
      const scores = await scorer.score({
        question,
        context: [...context],
        candidates: eligible.map((candidate) => ({
          id: candidate.id,
          text: candidate.text,
          headingPath: candidate.headingPath,
          features: candidate.features,
        })),
      })
      const byId = new Map(eligible.map((candidate, index) => [candidate.id, clamp(scores[index] ?? 0)]))
      scored = scored.map((candidate) => {
        const value = byId.get(candidate.id)
        return value === undefined ? candidate : { ...candidate, evidence: value }
      })
    }

    const key = order === 'selection' ? (entry: Scored) => selectionValue(entry.evidence, entry.novelty) : (entry: Scored) => entry.evidence
    return scored.sort((a, b) => key(b) - key(a) || a.id - b.id)
  }

  const trace: PipelineTrace = {
    mode,
    scorer: scorer.id,
    rounds: 0,
    candidates: 0,
    terms: [],
    ms: 0,
  }

  if (mode === 'expand-only') {
    // Control: seeds from lexical order only, one final scoring pass, no reselection.
    const seedScored = await scoreAll(new Set())
    const expansionTerms = extractExpansionTerms(
      seedScored.slice(0, seedK),
      terms,
      statsPort,
      new Set(),
      termsPerRound,
    )
    trace.terms.push(expansionTerms)
    for (const term of expansionTerms) {
      addHits(await search(db, term, { k: DEFAULTS.perTermK, expand: false, ...(sources ? { sources } : {}) }))
    }
    const ranked = await scoreAll(new Set())
    trace.candidates = pool.size
    trace.ms = Date.now() - started
    return { hits: ranked.slice(0, k).map((entry) => toHit(entry, pool)), trace }
  }

  const usedTerms = new Set<string>()
  let seeds = (await scoreAll(new Set())).slice(0, seedK)

  for (let round = 0; round < rounds; round += 1) {
    const context = coveredTerms(seeds, terms)
    const expansionTerms = extractExpansionTerms(seeds, terms, statsPort, usedTerms, termsPerRound)
    trace.terms.push(expansionTerms)
    if (expansionTerms.length === 0) break
    for (const term of expansionTerms) usedTerms.add(term)

    const perTerm: Hit[][] = []
    for (const term of expansionTerms) {
      perTerm.push(await search(db, term, { k: DEFAULTS.perTermK, expand: false, ...(sources ? { sources } : {}) }))
    }
    // Interleave by rank so no single term's tail floods the pool.
    const maxLength = Math.max(0, ...perTerm.map((hits) => hits.length))
    for (let rank = 0; rank < maxLength; rank += 1) {
      for (const hits of perTerm) {
        const hit = hits[rank]
        if (hit) addHits([hit])
      }
    }

    // Seeds for the next round reward evidence the current context does not cover.
    seeds = (await scoreAll(context, 'selection')).slice(0, seedK)
    trace.rounds = round + 1
  }

  const ranked = await scoreAll(coveredTerms(seeds, terms))
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
