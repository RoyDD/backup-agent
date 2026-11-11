export interface RetentionPolicy {
  daily: number
  weekly: number
  monthly: number
}

export interface RetentionArtifact {
  id: string
  parentId: string | null
  createdAt: string
  kind: string
  protected?: boolean
}

export interface RetentionDecision {
  keep: Set<string>
  remove: Set<string>
  reasons: Map<string, string>
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
 * GFS retention with dependency awareness. Retention roots are the newest
 * artifact per day/week/month bucket; every ancestor of a root is kept so an
 * incremental chain is never broken. Protected artifacts are always kept.
 */
export function planRetention(
  artifacts: readonly RetentionArtifact[],
  policy: RetentionPolicy,
  now: Date,
): RetentionDecision {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const roots = new Set<string>([
    ...latestPerBucket(artifacts, dayKey, policy.daily),
    ...latestPerBucket(artifacts, weekKey, policy.weekly),
    ...latestPerBucket(artifacts, monthKey, policy.monthly),
  ])

  const keep = new Set<string>()
  const reasons = new Map<string, string>()

  for (const id of roots) {
    if (!byId.has(id)) continue
    keep.add(id)
    reasons.set(id, 'gfs-root')
  }

  for (const artifact of artifacts) {
    if (artifact.protected === true) {
      keep.add(artifact.id)
      reasons.set(artifact.id, 'protected')
    }
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

export function totalBytes(artifacts: readonly { sizeBytes: number }[]): number {
  return artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)
}
