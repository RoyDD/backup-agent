import { isIdentifier } from './stats'
import type { CorpusStats } from './stats'
import type { QuestionTerms, Scored } from './score'

/**
 * Expansion-term selection.
 *
 * SAG2 seeds the next retrieval round with terms drawn from the passages scored
 * as necessary evidence, ranked by frequency, rarity, query context and score.
 * We keep rarity and seed agreement explicit, and bias identifiers (`archive_command`,
 * `--type=time`, `SQLSTATE`) upward because in this domain a concrete name transfers
 * far better than a prose word.
 */
export function extractExpansionTerms(
  seeds: Scored[],
  question: QuestionTerms,
  stats: CorpusStats,
  exclude: Set<string>,
  limit: number,
): string[] {
  if (seeds.length === 0) return []

  const agreement = new Map<string, number>()
  for (const seed of seeds) {
    for (const token of seed.tokens) {
      if (question.terms.has(token)) continue
      if (exclude.has(token)) continue
      if (stats.isCommon(token)) continue
      if (/^\d+$/.test(token)) continue
      const identifier = isIdentifier(token)
      if (!identifier && token.length < 4) continue
      agreement.set(token, (agreement.get(token) ?? 0) + 1)
    }
  }

  const scored: Array<{ term: string; weight: number }> = []
  for (const [term, count] of agreement) {
    const idf = stats.idf(term)
    const df = stats.documentFrequency(term)
    // Terms shared by several strong seeds are preferred; very frequent terms are
    // already excluded above, so the log damps only the mid-frequency band.
    const weight = idf * count * (isIdentifier(term) ? 1.6 : 1) / Math.log2(2 + df)
    scored.push({ term, weight })
  }

  scored.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
  return scored.slice(0, limit).map((entry) => entry.term)
}
