import type { AssetRpoStatus } from './assets'
import type { AlertEvent, AlertSeverity } from './notify'

/** Thresholds for the P1–P4 alert ladder in plan §12. */
export interface AlertPolicy {
  /** Consecutive failed/stalled attempts on one target before P2 fires. */
  failureStreak: number
  /** A target whose newest V2+ restore point is older than this is overdue (P3). */
  verifyOverdueDays: number
  /** Forecast horizon: P4 when the capacity threshold is projected within it. */
  capacityHorizonDays: number
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  failureStreak: 3,
  verifyOverdueDays: 7,
  capacityHorizonDays: 30,
}

/** Projection of `AttemptRecord` used by the failure-streak rule. */
export interface AlertAttempt {
  targetId: string | null | undefined
  state: string
  finishedAt: string | null | undefined
}

export interface AlertCapacity {
  daysUntilThreshold: number | null
}

export interface AlertInput {
  now: Date
  assets: readonly AssetRpoStatus[]
  /** Recent terminal attempts, any order; only finished ones are considered. */
  attempts: readonly AlertAttempt[]
  capacity?: AlertCapacity | null
  policy?: Partial<AlertPolicy>
}

const FAILED_STATES = new Set(['failed', 'stalled'])

function severityOrder(severity: AlertSeverity): number {
  return { P1: 0, P2: 1, P3: 2, P4: 3 }[severity]
}

/**
 * Evaluates the alert ladder from control-database facts.
 *
 * - P1: a registered target has no verified restore point inside its RPO.
 * - P2: one target accumulated `failureStreak` consecutive failed/stalled runs.
 * - P3: a target's newest V2+ restore point is older than `verifyOverdueDays`.
 * - P4: the capacity forecast crosses its threshold inside the horizon.
 *
 * Pure and deterministic: the caller supplies the clock, the asset RPO statuses,
 * the attempts and the forecast. The returned order is severity, then target, so
 * an operator reads the worst item first. `severityForRpo` in `notify.ts` is not
 * used here: it maps a boolean to a severity without a target or a message, and
 * the ladder is the single place that decides what counts as an alert.
 */
export function evaluateAlerts(input: AlertInput): AlertEvent[] {
  const policy: AlertPolicy = { ...DEFAULT_ALERT_POLICY, ...input.policy }
  const now = input.now.getTime()
  const alerts: AlertEvent[] = []

  for (const asset of input.assets) {
    if (asset.withinRpo) continue
    const missing = asset.lastVerifiedAt === null
    alerts.push({
      severity: 'P1',
      title: missing
        ? `no verified restore point for ${asset.targetId}`
        : `restore point for ${asset.targetId} is outside its RPO`,
      message: missing
        ? `target "${asset.targetId}" has no V2/V3 artifact; RPO ${asset.rpoMinutes}m cannot be claimed.`
        : `newest V2/V3 restore point for "${asset.targetId}" is ${Math.round(
            asset.ageMinutes ?? 0,
          )}m old; RPO is ${asset.rpoMinutes}m.`,
      labels: {
        targetId: asset.targetId,
        rpoMinutes: String(asset.rpoMinutes),
        reason: missing ? 'no-vrp' : 'vrp-too-old',
      },
      timestamp: input.now.toISOString(),
    })
  }

  const byTarget = new Map<string, AlertAttempt[]>()
  for (const attempt of input.attempts) {
    if (attempt.targetId === undefined || attempt.targetId === null) continue
    if (attempt.finishedAt === undefined || attempt.finishedAt === null) continue
    const list = byTarget.get(attempt.targetId) ?? []
    list.push(attempt)
    byTarget.set(attempt.targetId, list)
  }
  for (const [targetId, attempts] of byTarget) {
    const ordered = [...attempts].sort(
      (a, b) => Date.parse(b.finishedAt as string) - Date.parse(a.finishedAt as string),
    )
    let streak = 0
    for (const attempt of ordered) {
      if (!FAILED_STATES.has(attempt.state)) break
      streak += 1
    }
    if (streak < policy.failureStreak) continue
    alerts.push({
      severity: 'P2',
      title: `${streak} consecutive failed runs for ${targetId}`,
      message: `target "${targetId}" failed ${streak} times in a row (threshold ${policy.failureStreak}).`,
      labels: { targetId, streak: String(streak) },
      timestamp: input.now.toISOString(),
    })
  }

  for (const asset of input.assets) {
    if (asset.lastVerifiedAt === null || asset.ageMinutes === null) continue
    const ageDays = asset.ageMinutes / (60 * 24)
    if (ageDays <= policy.verifyOverdueDays) continue
    alerts.push({
      severity: 'P3',
      title: `verification overdue for ${asset.targetId}`,
      message: `newest V2/V3 restore point for "${asset.targetId}" is ${ageDays.toFixed(
        1,
      )} days old; verification is due every ${policy.verifyOverdueDays} days.`,
      labels: { targetId: asset.targetId, ageDays: ageDays.toFixed(1) },
      timestamp: input.now.toISOString(),
    })
  }

  const days = input.capacity?.daysUntilThreshold
  if (days !== undefined && days !== null && days <= policy.capacityHorizonDays) {
    alerts.push({
      severity: 'P4',
      title: 'repository capacity threshold projected',
      message:
        days <= 0
          ? 'the repository is already at its capacity threshold.'
          : `the repository is projected to reach its capacity threshold in ${Math.round(
              days,
            )} days (horizon ${policy.capacityHorizonDays}).`,
      labels: { daysUntilThreshold: String(Math.round(days)) },
      timestamp: input.now.toISOString(),
    })
  }

  return alerts.sort((a, b) => {
    const bySeverity = severityOrder(a.severity) - severityOrder(b.severity)
    if (bySeverity !== 0) return bySeverity
    return (a.labels?.['targetId'] ?? '') < (b.labels?.['targetId'] ?? '') ? -1 : 1
  })
}

/** True when any alert is P1/P2 (page-worthy). */
export function hasPageWorthyAlert(alerts: readonly AlertEvent[]): boolean {
  return alerts.some((alert) => alert.severity === 'P1' || alert.severity === 'P2')
}
