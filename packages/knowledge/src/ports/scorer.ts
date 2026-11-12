/**
 * Scoring port.
 *
 * SAG2's accuracy comes from the scorer that decides whether a passage supplies
 * *necessary evidence given the current context* — in the paper that is JEV, a
 * model call. We keep the seam and make the backend swappable:
 *
 * - `lexical`  deterministic feature blend; default, offline, no dependencies.
 * - `command`  an external reranker process speaking JSON over stdin/stdout.
 *              argv-only (`shell: false`), so it inherits the E-04 injection
 *              surface instead of inventing a new one.
 * - `jev`      HTTP endpoint with the same batch contract.
 *
 * Capability negotiation is fail-closed: an unconfigured or unreachable backend
 * raises, it never silently degrades to `lexical` (AGENTS.md: 不静默降级).
 */

export interface ScorerFeatures {
  /** Share of the question's idf mass present in the passage. */
  coverage: number
  /** Share of the question's identifiers (`archive_command`, `--type=time`) present. */
  identifier: number
  /** Share of the question's idf mass present in the heading path. */
  heading: number
  /** Pool-normalised BM25 in 0..1. */
  lex: number
  /** Share of the question's idf mass this passage adds beyond the current context. */
  novelty: number
}

export interface ScorerCandidate {
  id: number
  text: string
  headingPath: string
  features: ScorerFeatures
}

export interface ScorerRequest {
  question: string
  /** Terms already covered by the evidence selected in earlier rounds. */
  context: string[]
  candidates: ScorerCandidate[]
}

export interface ScorerHealth {
  ok: boolean
  detail: string
}

export interface ScorerPort {
  readonly id: string
  /** One score per candidate, in the same order. Higher is better. */
  score(request: ScorerRequest): Promise<number[]>
  /** Reachability/configuration probe, used by the CLI before a run. */
  health(): Promise<ScorerHealth>
}

export const LEXICAL_WEIGHTS = { coverage: 0.4, identifier: 0.15, heading: 0.1, lex: 0.35 } as const

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Default backend: the deterministic blend the P2 numbers were measured with. */
export const lexicalScorer: ScorerPort = {
  id: 'lexical',
  async score(request) {
    return request.candidates.map((candidate) => {
      const f = candidate.features
      return clamp(
        LEXICAL_WEIGHTS.coverage * f.coverage +
          LEXICAL_WEIGHTS.identifier * f.identifier +
          LEXICAL_WEIGHTS.heading * f.heading +
          LEXICAL_WEIGHTS.lex * f.lex,
      )
    })
  },
  async health() {
    return { ok: true, detail: 'deterministic feature blend, offline' }
  },
}

/** Validates a backend response before it can influence a ranking. */
export function assertScores(scores: unknown, expected: number, backend: string): number[] {
  if (!Array.isArray(scores)) {
    throw new Error(`${backend} scorer returned no scores array`)
  }
  if (scores.length !== expected) {
    throw new Error(`${backend} scorer returned ${scores.length} scores for ${expected} candidates`)
  }
  return scores.map((value, index) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`${backend} scorer returned a non-numeric score at index ${index}`)
    }
    return value
  })
}

/** Seeds for the next round need novelty; semantic scores alone make the loop inert. */
export function selectionValue(score: number, novelty: number): number {
  return 0.65 * clamp(score) + 0.35 * clamp(novelty)
}
