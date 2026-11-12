/**
 * Orphan collection for the agent's own storage root (plan §7: "orphan objects
 * are reclaimed by a periodic GC based on 'present but unreferenced and past
 * the grace period'").
 *
 * A key is *referenced* when any catalog row — of any lifecycle, including
 * tombstones that have not been purged yet — maps to it. Everything else in the
 * root is an orphan: a half-finished upload, a manually copied file, or bytes
 * left behind by a purge that crashed between delete and audit.
 *
 * **Scope**: this module never sees a provider, so it cannot classify
 * ownership. The caller MUST only run it against a `managed` storage root
 * (ADR-003). Running it against a pgBackRest/WAL-G repository, or against a
 * shared/NFS mount holding other tools' objects, would delete objects this
 * agent does not own. The grace period is the second guard: a young object may
 * belong to a write that has not been cataloged yet.
 */

import type { ArtifactRecord } from '../ports/repository'
import type { Storage, StorageStat } from '../ports/storage'

/** Default age before an unreferenced object is eligible for deletion. */
export const ORPHAN_GRACE_DAYS = 7

const MS_PER_DAY = 86_400_000

export interface OrphanGcCandidate {
  readonly key: string
  readonly bytes: number
  readonly modifiedAt: string | null
}

export interface OrphanGcPlan {
  readonly delete: OrphanGcCandidate[]
  /** Objects kept because a catalog row of any lifecycle maps to them. */
  readonly referenced: number
  /** Unreferenced objects younger than the grace period. */
  readonly withinGrace: number
  /** Unreferenced objects whose age cannot be established; kept, never guessed. */
  readonly unknownAge: number
}

export interface PlanOrphanGcInput {
  /** Everything currently present in the configured storage root. */
  readonly objects: readonly StorageStat[]
  readonly artifacts: readonly ArtifactRecord[]
  readonly now: string
  readonly graceDays?: number
  readonly keyOf: (artifact: ArtifactRecord) => string | null
}

function epoch(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined || iso === '') return null
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : null
}

function graceMs(graceDays: number | undefined): number {
  const days = graceDays ?? ORPHAN_GRACE_DAYS
  return (Number.isFinite(days) && days > 0 ? days : 0) * MS_PER_DAY
}

/**
 * Splits the storage listing into deletable orphans and everything that must
 * stay. Tombstoned rows count as references on purpose: purging them is the
 * purge phase's decision, made with its own provider and dependency checks, so
 * GC must not race it and delete an object whose row still exists.
 *
 * Deletion candidates are ordered by key so a review and its apply agree.
 */
export function planOrphanGc(input: PlanOrphanGcInput): OrphanGcPlan {
  const grace = graceMs(input.graceDays)
  const nowMs = epoch(input.now)

  const referencedKeys = new Set<string>()
  for (const artifact of input.artifacts) {
    const key = input.keyOf(artifact)
    if (key === null || key === '') continue
    referencedKeys.add(key)
  }

  const deletable: OrphanGcCandidate[] = []
  let referenced = 0
  let withinGrace = 0
  let unknownAge = 0

  for (const object of input.objects) {
    if (referencedKeys.has(object.key)) {
      referenced += 1
      continue
    }

    const modifiedMs = epoch(object.modifiedAt)
    if (modifiedMs === null) {
      unknownAge += 1
      continue
    }

    if (nowMs !== null && modifiedMs > nowMs - grace) {
      withinGrace += 1
      continue
    }

    deletable.push({ key: object.key, bytes: object.bytes, modifiedAt: object.modifiedAt })
  }

  deletable.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { delete: deletable, referenced, withinGrace, unknownAge }
}

export interface OrphanGcReport {
  readonly deleted: string[]
  readonly failed: { key: string; error: string }[]
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Deletes the planned orphans.
 *
 * `delete` returning `false` means the object was already absent; that is the
 * intended end state, so the key is reported as `deleted` and a re-run after a
 * crash is idempotent. A thrown error is recorded under `failed` and the loop
 * continues. The caller should write the report into lineage/audit alongside
 * the purged artifact ids.
 */
export async function applyOrphanGc(
  storage: Storage,
  plan: OrphanGcPlan,
): Promise<OrphanGcReport> {
  const deleted: string[] = []
  const failed: { key: string; error: string }[] = []

  for (const candidate of plan.delete) {
    try {
      await storage.delete(candidate.key)
      // false = already gone: the object is no longer present either way.
      deleted.push(candidate.key)
    } catch (err) {
      failed.push({ key: candidate.key, error: describe(err) })
    }
  }

  return { deleted, failed }
}
