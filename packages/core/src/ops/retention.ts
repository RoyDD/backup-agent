import { createHash } from 'node:crypto'

import { canonicalJson } from '../plan/fingerprint'

export interface RetentionPolicy {
  daily: number
  weekly: number
  monthly: number
}

export interface RetentionArtifact {
  id: string
  /** Retention is decided per target; roots never span target boundaries. */
  targetId: string
  parentId: string | null
  createdAt: string
  kind: string
  provider?: string
  protected?: boolean
  /** Set for verified artifacts; V2/V3 are Verified Restore Point evidence. */
  verifiedLevel?: string | null
  verifiedAt?: string | null
  sizeBytes?: number
}

export interface RetentionDecision {
  keep: Set<string>
  remove: Set<string>
  reasons: Map<string, string>
}

/**
 * How retention may treat an artifact's bytes. `managed` paths are owned by
 * this agent's own storage; `provider-owned` repositories can only be pruned
 * through the vendor tool (pgBackRest/WAL-G). Anything else is unknown and is
 * refused rather than guessed.
 */
export const RETENTION_PROVIDER_CLASSES = ['managed', 'provider-owned', 'unknown'] as const
export type RetentionProviderClass = (typeof RETENTION_PROVIDER_CLASSES)[number]

export const MANAGED_PROVIDERS: readonly string[] = ['native-logical', 'native-physical']
export const PROVIDER_OWNED_PROVIDERS: readonly string[] = ['pgbackrest', 'walg']

/** Levels that count as Verified Restore Point evidence. */
export const VERIFIED_RESTORE_POINT_LEVELS: readonly string[] = ['V2', 'V3']

export function classifyRetentionProvider(provider: string): RetentionProviderClass {
  if (MANAGED_PROVIDERS.includes(provider)) return 'managed'
  if (PROVIDER_OWNED_PROVIDERS.includes(provider)) return 'provider-owned'
  return 'unknown'
}

/**
 * The operator command that actually reclaims a provider-owned repository's
 * bytes. Retention only tombstones catalog metadata; it never invokes these.
 */
export function providerRetentionGuidance(provider: string): string {
  switch (provider) {
    case 'pgbackrest':
      return 'pgbackrest expire --config <path> --stanza <name> (bkagent pgbackrest-expire --yes)'
    case 'walg':
      return 'wal-g delete retain FULL <n> --confirm (bkagent walg-prune --retain-full <n> --yes)'
    default:
      return 'no retention command is known for this provider; inspect the catalog row before removing it'
  }
}

function timestamp(artifact: RetentionArtifact): number {
  const at = Date.parse(artifact.verifiedAt ?? artifact.createdAt)
  return Number.isFinite(at) ? at : 0
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7)
}

/** ISO-8601 week key, e.g. 2026-W02. */
function weekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNumber = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay()
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNumber)
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function latestPerBucket(
  artifacts: readonly RetentionArtifact[],
  bucket: (date: Date) => string,
  limit: number,
): string[] {
  if (limit <= 0) return []
  const sorted = [...artifacts].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
  const seen = new Set<string>()
  const selected: string[] = []
  for (const artifact of sorted) {
    const key = bucket(new Date(artifact.createdAt))
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(artifact.id)
    if (selected.length >= limit) break
  }
  return selected
}

/**
 * The newest V2/V3 artifact of one target: the target's most recent Verified
 * Restore Point evidence. Keeping only the newest is enough to prove the
 * target was restored and verified recently, and its ancestors keep the chain
 * that evidence depends on.
 */
function latestVerifiedRestorePoint(
  artifacts: readonly RetentionArtifact[],
): RetentionArtifact | undefined {
  return artifacts
    .filter(
      (artifact) =>
        artifact.verifiedLevel !== null &&
        artifact.verifiedLevel !== undefined &&
        VERIFIED_RESTORE_POINT_LEVELS.includes(artifact.verifiedLevel),
    )
    .sort((a, b) => timestamp(b) - timestamp(a) || b.id.localeCompare(a.id))[0]
}

/**
 * GFS retention with dependency awareness, evaluated **per target**.
 *
 * Roots are the newest artifact per day/week/month bucket *within each target*,
 * so one target's daily root cannot keep another target's artifact alive. Each
 * target's latest V2/V3 Verified Restore Point is kept together with its
 * ancestors, and every ancestor of every kept artifact is kept so an
 * incremental chain is never broken. Protected artifacts are always kept, and
 * every artifact of an `asset-protected` target is kept with `asset-protected`
 * so a missing row-level flag cannot bypass target protection.
 */
export interface RetentionPlanOptions {
  /**
   * Targets whose registered Asset is `protected`. Every artifact of such a
   * target is kept with reason `asset-protected`: protection is a target-level
   * promise, not an artifact-level flag that a catalog row can be missing.
   */
  readonly protectedTargets?: ReadonlySet<string> | readonly string[]
}

export function planRetention(
  artifacts: readonly RetentionArtifact[],
  policy: RetentionPolicy,
  now: Date,
  options: RetentionPlanOptions = {},
): RetentionDecision {
  // Buckets are derived from artifact timestamps only; `now` is accepted for
  // symmetry with the other planning functions and kept for callers/tests.
  void now
  const protectedTargets = new Set(options.protectedTargets ?? [])
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const byTarget = new Map<string, RetentionArtifact[]>()
  for (const artifact of artifacts) {
    const group = byTarget.get(artifact.targetId)
    if (group === undefined) byTarget.set(artifact.targetId, [artifact])
    else group.push(artifact)
  }

  const keep = new Set<string>()
  const reasons = new Map<string, string>()

  for (const group of byTarget.values()) {
    const roots = [
      ...latestPerBucket(group, dayKey, policy.daily),
      ...latestPerBucket(group, weekKey, policy.weekly),
      ...latestPerBucket(group, monthKey, policy.monthly),
    ]
    for (const id of roots) {
      if (!byId.has(id)) continue
      keep.add(id)
      reasons.set(id, 'gfs-root')
    }

    const vrp = latestVerifiedRestorePoint(group)
    if (vrp !== undefined) {
      keep.add(vrp.id)
      reasons.set(vrp.id, 'vrp-latest')
    }
  }

  for (const artifact of artifacts) {
    if (artifact.protected === true) {
      keep.add(artifact.id)
      reasons.set(artifact.id, 'protected')
    }
  }

  // Target-level protection wins over every bucket rule: a protected asset
  // never schedules any of its artifacts for removal.
  for (const artifact of artifacts) {
    if (!protectedTargets.has(artifact.targetId)) continue
    keep.add(artifact.id)
    reasons.set(artifact.id, 'asset-protected')
  }

  // Walk ancestors of every kept artifact.
  const stack = [...keep]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) continue
    const artifact = byId.get(id)
    if (!artifact || artifact.parentId === null) continue
    if (keep.has(artifact.parentId)) continue
    keep.add(artifact.parentId)
    reasons.set(artifact.parentId, `ancestor-of:${id}`)
    stack.push(artifact.parentId)
  }

  const remove = new Set<string>()
  for (const artifact of artifacts) {
    if (keep.has(artifact.id)) continue
    remove.add(artifact.id)
    reasons.set(artifact.id, 'outside-retention')
  }

  // A kept artifact must never be scheduled for removal.
  for (const id of keep) remove.delete(id)

  return { keep, remove, reasons }
}

export interface RetentionDigestInput {
  readonly targetId: string
  readonly policy: RetentionPolicy
  readonly candidateIds: readonly string[]
}

/**
 * Digest that binds an `--apply` run to the exact dry-run decision it was
 * reviewed from: same target, same policy, same sorted candidate ids. Anything
 * appearing, disappearing or changing target between dry run and apply changes
 * the digest and refuses the apply before any write.
 */
export function retentionDigest(input: RetentionDigestInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        targetId: input.targetId,
        policy: {
          daily: input.policy.daily,
          weekly: input.policy.weekly,
          monthly: input.policy.monthly,
        },
        candidates: [...input.candidateIds].sort(),
      }),
    )
    .digest('hex')
}

export function totalBytes(artifacts: readonly { sizeBytes: number }[]): number {
  return artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)
}
