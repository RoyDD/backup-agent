/**
 * Long-term step memory: retrieval and construction.
 *
 * Memory is written by the core on every terminal step and read before the
 * next plan; retrieval is deterministic and offline, so the same memory yields
 * the same context. Nothing here ranks by wall clock or randomness: ties are
 * broken by `createdAt` and then by `memoryId`, so a replay produces the same
 * order on any host.
 *
 * The builder exists so a caller cannot persist an action that still carries
 * credentials: every entry's action passes through `redactAction` first.
 */

import { redactAction, type StepAction } from '../domain/action'
import type { ErrorClass } from '../domain/errors'
import type { GoalId, GoalStepId, MemoryId, TargetId } from '../domain/ids'
import type { MemoryEntry } from '../ports/repository'

export interface MemoryQuery {
  readonly targetId?: TargetId
  readonly signature?: string
  /** Free text from the goal intent or the failed action. */
  readonly text?: string
  readonly limit?: number
}

export interface MemoryHit {
  readonly entry: MemoryEntry
  readonly score: number
}

export interface MemoryInput {
  readonly memoryId: MemoryId
  readonly targetId: TargetId
  readonly goalId: GoalId | null
  readonly stepId: GoalStepId | null
  readonly kind: 'outcome' | 'lesson'
  readonly signature: string
  readonly action: StepAction
  readonly state: string
  readonly exitCode: number | null
  readonly error: string | null
  readonly errorClass: ErrorClass | null
  readonly createdAt: string
}

const DEFAULT_LIMIT = 5
const MIN_LIMIT = 1
const MAX_LIMIT = 50

const SIGNATURE_MATCH = 5
const TARGET_MATCH = 3
const MAX_TOKEN_OVERLAP = 3
const SUCCESS_PRECEDENT = 1

/** Anything that is not a letter, a digit or an underscore separates tokens. */
const TOKEN_SEPARATOR = /[^\p{L}\p{N}_]+/u
const MIN_TOKEN_LENGTH = 2

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT
  const limit = Math.trunc(value)
  if (limit < MIN_LIMIT) return MIN_LIMIT
  if (limit > MAX_LIMIT) return MAX_LIMIT
  return limit
}

function tokenize(value: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of value.split(TOKEN_SEPARATOR)) {
    if (raw === '') continue
    const token = raw.toLowerCase()
    if (token.length < MIN_TOKEN_LENGTH) continue
    tokens.add(token)
  }
  return tokens
}

function timestamp(value: string): number {
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : 0
}

/** Score desc, then newest first, then id asc so equal rows keep one order. */
function compareHits(left: MemoryHit, right: MemoryHit): number {
  if (left.score !== right.score) return right.score - left.score
  const recency = timestamp(right.entry.createdAt) - timestamp(left.entry.createdAt)
  if (recency !== 0) return recency
  if (left.entry.memoryId < right.entry.memoryId) return -1
  if (left.entry.memoryId > right.entry.memoryId) return 1
  return 0
}

/**
 * Ranks remembered entries for a query.
 *
 * Scoring is additive: an exact signature match, a target match, distinct
 * token overlap (capped) and a successful precedent each contribute. A query
 * that names nothing keeps every entry so recency alone decides; otherwise a
 * zero score means "nothing in common" and the entry is dropped.
 */
export function recall(entries: readonly MemoryEntry[], query: MemoryQuery): MemoryHit[] {
  const hasSignature = query.signature !== undefined
  const hasTarget = query.targetId !== undefined
  const queryTokens = query.text === undefined ? new Set<string>() : tokenize(query.text)
  const emptyQuery = !hasSignature && !hasTarget && queryTokens.size === 0

  const hits: MemoryHit[] = []
  for (const entry of entries) {
    let score = 0
    if (hasSignature && entry.signature === query.signature) score += SIGNATURE_MATCH
    if (hasTarget && entry.targetId === query.targetId) score += TARGET_MATCH

    if (queryTokens.size > 0) {
      const haystack = tokenize(
        `${entry.action.command} ${entry.signature} ${entry.outcome.error ?? ''} ${entry.outcome.state}`,
      )
      let overlap = 0
      for (const token of queryTokens) {
        if (haystack.has(token)) overlap += 1
      }
      score += Math.min(overlap, MAX_TOKEN_OVERLAP)
    }

    if (entry.success) score += SUCCESS_PRECEDENT

    if (score === 0 && !emptyQuery) continue
    hits.push({ entry, score })
  }

  hits.sort(compareHits)
  return hits.slice(0, clampLimit(query.limit))
}

/** Builds a memory entry, redacting credentials from the action. */
export function memoryEntryFor(input: MemoryInput): MemoryEntry {
  return {
    memoryId: input.memoryId,
    targetId: input.targetId,
    goalId: input.goalId,
    stepId: input.stepId,
    kind: input.kind,
    signature: input.signature,
    action: redactAction(input.action),
    outcome: {
      command: input.action.command,
      state: input.state,
      exitCode: input.exitCode,
      error: input.error,
    },
    errorClass: input.errorClass,
    success: input.state === 'succeeded',
    createdAt: input.createdAt,
  }
}
