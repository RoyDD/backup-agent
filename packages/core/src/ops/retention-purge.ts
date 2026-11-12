/**
 * Second phase of the two-phase deletion described in plan §7:
 *
 *   mark tombstone -> recompute reachability, no dependents -> delete bytes ->
 *   record the result -> write lineage and audit
 *
 * `retention-apply.ts` performs the first phase: it flips catalog rows to
 * `tombstoned` and never touches bytes. This module performs the byte phase for
 * artifacts this agent owns. It is pure planning plus a thin apply loop, so the
 * decision can be reviewed (and audited) before any destructive call.
 *
 * The apply functions return a report but write nothing else: the caller is
 * responsible for persisting lineage and the audit/outbox event, because only
 * the caller holds a `Repository` transaction. Refusals for provider-owned and
 * unknown repositories are not errors: they are reported as skips and the
 * vendor tool (pgBackRest/WAL-G) remains the only way to reclaim those bytes
 * (ADR-003).
 */

import type { ArtifactId } from '../domain/ids'
import type { ArtifactRecord } from '../ports/repository'
import type { Storage } from '../ports/storage'
import { classifyRetentionProvider } from './retention'

/** Default tombstone age before bytes may be reclaimed. */
export const PURGE_GRACE_DAYS = 7

const MS_PER_DAY = 86_400_000

export interface PurgeCandidate {
  readonly id: ArtifactId
  readonly key: string
  readonly path: string
  readonly provider: string
}

/**
 * Why an artifact was not queued for byte deletion.
 *
 * Precedence, evaluated in this order per artifact, first match wins:
 * `not-tombstoned` -> `provider-owned`/`unknown-provider` -> `within-grace` ->
 * `missing-path` -> `outside-storage` -> `has-live-child`.
 */
export type PurgeSkipReason =
  | 'not-tombstoned'
  | 'provider-owned'
  | 'unknown-provider'
  | 'within-grace'
  | 'has-live-child'
  | 'outside-storage'
  | 'missing-path'

export interface PurgeSkip {
  readonly id: ArtifactId
  readonly reason: PurgeSkipReason
  readonly detail?: string
}

export interface PurgePlan {
  readonly candidates: PurgeCandidate[]
  readonly skipped: PurgeSkip[]
}

export interface PlanPurgeInput {
  /** Every artifact row, both lifecycles (`list({ lifecycle: 'any' })`). */
  readonly artifacts: readonly ArtifactRecord[]
  readonly now: string
  /** Tombstones younger than this are not purged yet. Default 7. */
  readonly graceDays?: number
  /** Storage key for a managed artifact path; null when the path is outside the configured storage. */
  readonly keyOf: (artifact: ArtifactRecord) => string | null
}

/** Parse an ISO timestamp, or null when absent/unparseable. */
function epoch(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === '') return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : null
}

function graceMs(graceDays: number | undefined): number {
  const days = graceDays ?? PURGE_GRACE_DAYS
  // A negative grace is meaningless; clamp instead of silently purging fresher
  // tombstones than the operator asked for.
  return (Number.isFinite(days) && days > 0 ? days : 0) * MS_PER_DAY
}

/**
 * Deterministic review order: oldest tombstone first, `id` ascending as the
 * tie-break. Rows without a parseable `tombstonedAt` sort last; they are
 * skipped anyway, but the position must not depend on input order.
 */
function compareByTombstone(a: ArtifactRecord, b: ArtifactRecord): number {
  const at = epoch(a.tombstonedAt) ?? Number.POSITIVE_INFINITY
  const bt = epoch(b.tombstonedAt) ?? Number.POSITIVE_INFINITY
  if (at !== bt) return at < bt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Decides which tombstoned artifacts may lose their bytes.
 *
 * A candidate is a row that is `tombstoned`, owned by this agent (`managed`
 * provider), past the grace period, inside the configured storage, and not the
 * parent of any **live** artifact. The live-child check is the re-computed
 * reachability in plan §7: a tombstoned row is no longer eligible for new
 * children, so a live child pointing at it means the row was tombstoned too
 * early or resurrected, and the bytes are still needed.
 */
export function planPurge(input: PlanPurgeInput): PurgePlan {
  const grace = graceMs(input.graceDays)
  const nowMs = epoch(input.now)

  const liveParents = new Set<string>()
  for (const artifact of input.artifacts) {
    if (artifact.lifecycleState === 'tombstoned') continue
    if (artifact.parentId === null) continue
    liveParents.add(artifact.parentId)
  }

  const candidates: PurgeCandidate[] = []
  const skipped: PurgeSkip[] = []

  for (const artifact of [...input.artifacts].sort(compareByTombstone)) {
    const { id } = artifact

    if (artifact.lifecycleState !== 'tombstoned') {
      skipped.push({ id, reason: 'not-tombstoned' })
      continue
    }

    const ownership = classifyRetentionProvider(artifact.provider)
    if (ownership !== 'managed') {
      skipped.push({
        id,
        reason: ownership === 'provider-owned' ? 'provider-owned' : 'unknown-provider',
        detail: artifact.provider,
      })
      continue
    }

    const tombstonedMs = epoch(artifact.tombstonedAt)
    if (tombstonedMs === null || (nowMs !== null && tombstonedMs > nowMs - grace)) {
      skipped.push({
        id,
        reason: 'within-grace',
        detail: artifact.tombstonedAt ?? 'no tombstonedAt',
      })
      continue
    }

    if (artifact.path.trim() === '') {
      skipped.push({ id, reason: 'missing-path', detail: 'artifact path is empty' })
      continue
    }

    const key = input.keyOf(artifact)
    if (key === null || key === '') {
      skipped.push({ id, reason: 'outside-storage', detail: artifact.path })
      continue
    }

    if (liveParents.has(id)) {
      skipped.push({
        id,
        reason: 'has-live-child',
        detail: 'at least one live artifact references this row as parentId',
      })
      continue
    }

    candidates.push({ id, key, path: artifact.path, provider: artifact.provider })
  }

  return { candidates, skipped }
}

export interface PurgeReport {
  readonly purged: ArtifactId[]
  readonly missing: ArtifactId[]
  readonly failed: { id: ArtifactId; error: string }[]
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Deletes the planned objects, one candidate at a time.
 *
 * `delete` returning `false` means the object was already gone, which makes a
 * retried purge idempotent: the id is reported under `missing`, never as an
 * error. A thrown storage error is recorded under `failed` with its message and
 * the loop continues, so one unreachable object cannot strand the rest of an
 * already-approved batch. The caller must treat a non-empty `failed` as a
 * partially failed run and must not report the batch as fully reclaimed.
 */
export async function applyPurge(storage: Storage, plan: PurgePlan): Promise<PurgeReport> {
  const purged: ArtifactId[] = []
  const missing: ArtifactId[] = []
  const failed: { id: ArtifactId; error: string }[] = []

  for (const candidate of plan.candidates) {
    try {
      const removed = await storage.delete(candidate.key)
      if (removed) purged.push(candidate.id)
      else missing.push(candidate.id)
    } catch (err) {
      failed.push({ id: candidate.id, error: describe(err) })
    }
  }

  return { purged, missing, failed }
}
