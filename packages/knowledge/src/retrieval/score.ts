import { tokenize } from '../text/tokenize'
import { isIdentifier, type CorpusStats } from './stats'

/**
 * Deterministic stand-in for SAG2's JEV scorer.
 *
 * JEV asks "does this passage supply necessary evidence for the question, given
 * the context already gathered", and it is a model call. We keep the shape and
 * drop the model: coverage of the question's aspects, identifier hits, heading
 * hits, and how much *new* evidence the passage contributes beyond what is
 * already selected. Round-to-round change in the last term is what lets a second
 * hop move away from paraphrases of the first passage.
 */

export interface Scorable {
  id: number
  text: string
  headingPath: string
  /** Raw FTS5 bm25 (negative, smaller is better). */
  bm25?: number
}

export interface Scored extends Scorable {
  tokens: Set<string>
  headingTokens: Set<string>
  coverage: number
  identifier: number
  heading: number
  novelty: number
  evidence: number
}

export interface QuestionTerms {
  /** token → idf */
  terms: Map<string, number>
  identifiers: string[]
  totalIdf: number
}

export function questionTerms(question: string, stats: CorpusStats, extra = ''): QuestionTerms {
  const terms = new Map<string, number>()
  for (const token of tokenize(`${question} ${extra}`)) {
    if (terms.has(token)) continue
    if (stats.isCommon(token, 0.4)) continue
    const idf = stats.idf(token)
    if (idf <= 0) continue
    terms.set(token, idf)
  }
  const identifiers = [...terms.keys()].filter((token) => isIdentifier(token))
  const totalIdf = [...terms.values()].reduce((sum, value) => sum + value, 0)
  return { terms, identifiers, totalIdf }
}

function normalizeBm25(value: number | undefined, min: number, max: number): number {
  if (value === undefined) return 0
  if (max <= min) return 1
  // bm25 is negative and lower is better, so invert it into a 0..1 score.
  return (max - value) / (max - min)
}

export function scorePassage(
  passage: Scorable,
  question: QuestionTerms,
  stats: CorpusStats,
  options: { context?: Set<string>; bm25Range?: { min: number; max: number } } = {},
): Scored {
  const tokens = new Set(tokenize(passage.text))
  const headingTokens = new Set(tokenize(passage.headingPath))

  let matchedIdf = 0
  let newIdf = 0
  for (const [term, idf] of question.terms) {
    if (!tokens.has(term)) continue
    matchedIdf += idf
    if (!options.context?.has(term)) newIdf += idf
  }

  const coverage = question.totalIdf > 0 ? matchedIdf / question.totalIdf : 0
  const novelty = question.totalIdf > 0 ? newIdf / question.totalIdf : 0

  let identifier = 0
  if (question.identifiers.length > 0) {
    const hits = question.identifiers.filter((token) => tokens.has(token)).length
    identifier = hits / question.identifiers.length
  }

  let headingMatched = 0
  for (const [term, idf] of question.terms) if (headingTokens.has(term)) headingMatched += idf
  const heading = question.totalIdf > 0 ? headingMatched / question.totalIdf : 0

  const range = options.bm25Range ?? { min: 0, max: 0 }
  const lex = normalizeBm25(passage.bm25, range.min, range.max)

  void stats // stats is threaded for callers that extend the feature set
  const evidence = 0.40 * coverage + 0.15 * identifier + 0.10 * heading + 0.35 * lex

  return {
    ...passage,
    tokens,
    headingTokens,
    coverage,
    identifier,
    heading,
    novelty,
    evidence: Number.isFinite(evidence) ? evidence : 0,
  }
}

/**
 * Score used to pick *seeds for the next round*, as opposed to the final ranking.
 * The novelty term is what makes a second hop possible: without it, every round
 * re-selects the same paraphrase of the first passage, the expansion terms never
 * change, and the loop is inert.
 */
export function selectionScore(scored: Scored): number {
  return 0.65 * scored.evidence + 0.35 * scored.novelty
}

export function bm25Range(passages: Array<{ bm25?: number }>): { min: number; max: number } {
  let min = 0
  let max = 0
  let seen = false
  for (const passage of passages) {
    if (passage.bm25 === undefined) continue
    if (!seen) {
      min = passage.bm25
      max = passage.bm25
      seen = true
      continue
    }
    if (passage.bm25 < min) min = passage.bm25
    if (passage.bm25 > max) max = passage.bm25
  }
  return { min, max }
}

/** Terms the selected evidence already covers; later rounds should look elsewhere. */
export function coveredTerms(seeds: Scored[], question: QuestionTerms): Set<string> {
  const covered = new Set<string>()
  for (const seed of seeds) {
    for (const term of question.terms.keys()) if (seed.tokens.has(term)) covered.add(term)
  }
  return covered
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const token of small) if (large.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * Maximal marginal relevance, the cheap local substitute for SAG2's DPP step:
 * reward evidence, penalise redundancy against what is already chosen.
 */
export function mmrRank(ranked: Scored[], k: number, lambda = 0.7): Scored[] {
  const remaining = [...ranked]
  const chosen: Scored[] = []

  while (remaining.length > 0 && chosen.length < k) {
    let bestIndex = 0
    let bestValue = Number.NEGATIVE_INFINITY
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index] as Scored
      let similarity = 0
      for (const picked of chosen) similarity = Math.max(similarity, jaccard(candidate.tokens, picked.tokens))
      const value = lambda * candidate.evidence - (1 - lambda) * similarity
      if (value > bestValue) {
        bestValue = value
        bestIndex = index
      }
    }
    chosen.push(remaining[bestIndex] as Scored)
    remaining.splice(bestIndex, 1)
  }

  return chosen
}
