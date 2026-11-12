import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'

import type { ScorerPort } from '../ports/scorer'
import { runPipeline, type RetrievalMode } from '../retrieval/pipeline'
import type { EvalQuestion, EvalSummary, GoldRef, QuestionResult, ResolvedGold } from '../types'

export const K_LIST = [1, 2, 5, 10] as const

interface PassageLookup {
  id: number
  source_id: string
  ordinal: number
  text: string
}

/**
 * Gold evidence is declared as (source, substring) so questions survive chunking
 * changes: a re-chunk moves passage boundaries but the fact stays the same text.
 * `source#ordinal` pins one exact passage when a substring is not unique.
 */
export function resolveGold(db: DatabaseSync, ref: GoldRef): number[] {
  if (ref.passage) {
    const [source, ordinal] = ref.passage.split('#')
    if (!source || ordinal === undefined) return []
    const row = db
      .prepare('SELECT id FROM passage WHERE source_id = ? AND ordinal = ?')
      .get(source, Number(ordinal)) as { id: number } | undefined
    return row ? [row.id] : []
  }

  const conditions = ['source_id = ?']
  const params: Array<string | number> = [ref.source]
  if (ref.heading) {
    conditions.push('instr(lower(heading_path), lower(?)) > 0')
    params.push(ref.heading)
  }
  if (ref.contains) {
    conditions.push('instr(lower(text), lower(?)) > 0')
    params.push(ref.contains)
  }
  if (conditions.length === 1) return []
  const rows = db
    .prepare(`SELECT id FROM passage WHERE ${conditions.join(' AND ')}`)
    .all(...params) as Array<{ id: number }>
  return rows.map((row) => row.id)
}

function recallAt(gold: Set<number>, hits: number[], k: number): number {
  if (gold.size === 0) return 0
  let found = 0
  for (const id of hits.slice(0, k)) if (gold.has(id)) found += 1
  return found / gold.size
}

function allEvidenceAt(gold: Set<number>, hits: number[], k: number): boolean {
  if (gold.size === 0) return false
  const top = new Set(hits.slice(0, k))
  for (const id of gold) if (!top.has(id)) return false
  return true
}

function percentileSummary(values: number[]): { mean: number; p50: number; p95: number } {
  if (values.length === 0) return { mean: 0, p50: 0, p95: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (quantile: number): number => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0
  return { mean: mean(values), p50: at(0.5), p95: at(0.95) }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function loadQuestions(path: string): EvalQuestion[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line, index) => {
      const parsed = JSON.parse(line) as EvalQuestion
      if (!parsed.id || !parsed.question || !Array.isArray(parsed.gold)) {
        throw new Error(`invalid question on line ${index + 1} of ${path}`)
      }
      return parsed
    })
}

export interface EvalOptions {
  questionsPath: string
  k?: number
  /** Restrict retrieval to a single corpus source id, for per-source diagnostics. */
  sources?: string[]
  /** Alias-dictionary query rewriting. Default: on. */
  expand?: boolean
  mode?: RetrievalMode
  rounds?: number
  seedK?: number
  termsPerRound?: number
  diversify?: boolean
  /** Scoring backend; defaults to the deterministic lexical blend. */
  scorer?: ScorerPort
}

export async function runEval(
  db: DatabaseSync,
  options: EvalOptions,
): Promise<{ summary: EvalSummary; results: QuestionResult[] }> {
  const questions = loadQuestions(options.questionsPath)
  const k = options.k ?? Math.max(...K_LIST)
  const results: QuestionResult[] = []
  const unresolvedGold: Array<{ id: string; ref: GoldRef }> = []
  const latencies: number[] = []
  const mode: RetrievalMode = options.mode ?? 'bm25'

  for (const question of questions) {
    const gold: ResolvedGold[] = question.gold.map((ref) => {
      const passageIds = resolveGold(db, ref)
      if (passageIds.length === 0) unresolvedGold.push({ id: question.id, ref })
      return { ...ref, passageIds }
    })

    const goldIds = new Set(gold.flatMap((entry) => entry.passageIds))
    const pipeline = await runPipeline(db, question.question, {
      mode,
      k: Math.max(k, 10),
      ...(options.sources ? { sources: options.sources } : {}),
      expandAliases: options.expand !== false,
      ...(options.rounds === undefined ? {} : { rounds: options.rounds }),
      ...(options.seedK === undefined ? {} : { seedK: options.seedK }),
      ...(options.termsPerRound === undefined ? {} : { termsPerRound: options.termsPerRound }),
      ...(options.diversify === undefined ? {} : { diversify: options.diversify }),
      ...(options.scorer === undefined ? {} : { scorer: options.scorer }),
    })
    latencies.push(pipeline.trace.ms)
    const hits = pipeline.hits.map((hit) => hit.passageId)

    const recall: Record<string, number> = {}
    const allEvidence: Record<string, boolean> = {}
    for (const cutoff of K_LIST) {
      recall[String(cutoff)] = recallAt(goldIds, hits, cutoff)
      allEvidence[String(cutoff)] = allEvidenceAt(goldIds, hits, cutoff)
    }

    let reciprocal = 0
    for (let index = 0; index < Math.min(hits.length, 10); index += 1) {
      if (goldIds.has(hits[index] as number)) {
        reciprocal = 1 / (index + 1)
        break
      }
    }

    results.push({
      id: question.id,
      kind: question.kind,
      lang: question.lang ?? 'zh',
      question: question.question,
      gold,
      hits: hits.slice(0, k),
      recallAt: recall,
      allEvidenceAt: allEvidence,
      mrrAt10: reciprocal,
    })
  }

  const aggregate = (subset: QuestionResult[]) => ({
    recallAt: Object.fromEntries(K_LIST.map((cutoff) => [String(cutoff), mean(subset.map((r) => r.recallAt[String(cutoff)] ?? 0))])),
    allEvidenceAt: Object.fromEntries(K_LIST.map((cutoff) => [String(cutoff), mean(subset.map((r) => (r.allEvidenceAt[String(cutoff)] ? 1 : 0))) > 0.5])),
  })

  const kinds: Record<string, number> = {}
  for (const result of results) kinds[result.kind] = (kinds[result.kind] ?? 0) + 1

  const byKind: EvalSummary['byKind'] = {}
  for (const kind of Object.keys(kinds)) {
    const subset = results.filter((result) => result.kind === kind)
    const agg = aggregate(subset)
    byKind[kind] = { questions: subset.length, recallAt: agg.recallAt, allEvidenceAt: agg.allEvidenceAt }
  }

  const langs: Record<string, number> = {}
  for (const result of results) langs[result.lang] = (langs[result.lang] ?? 0) + 1
  const byLang: EvalSummary['byLang'] = {}
  for (const lang of Object.keys(langs)) {
    const subset = results.filter((result) => result.lang === lang)
    const agg = aggregate(subset)
    byLang[lang] = { questions: subset.length, recallAt: agg.recallAt, allEvidenceAt: agg.allEvidenceAt }
  }

  const overall = aggregate(results)
  return {
    summary: {
      questions: results.length,
      kinds,
      unresolvedGold,
      recallAt: overall.recallAt,
      allEvidenceAt: overall.allEvidenceAt,
      mrrAt10: mean(results.map((result) => result.mrrAt10)),
      byKind,
      byLang,
      latency: percentileSummary(latencies),
      settings: {
        k,
        retrieval: mode,
        scorer: options.scorer?.id ?? 'lexical',
        rounds: mode === 'sag2' ? (options.rounds ?? 2) : 0,
        diversify: mode === 'sag2' ? options.diversify === true : false,
        expand: options.expand === false ? 'none' : 'aliases',
        sources: options.sources ?? 'all',
      },
    },
    results,
  }
}
