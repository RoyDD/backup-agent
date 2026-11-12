import { createHash } from 'node:crypto'
import type { Plan, PlanFingerprint } from '../domain/plan'

/** Deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const entry = source[key]
      if (entry !== undefined) sorted[key] = sortValue(entry)
    }
    return sorted
  }
  return value
}

/** Digest of the executable content of a Plan. */
export function fingerprintPlan(plan: Plan): string {
  const payload = {
    engine: plan.engine,
    provider: plan.provider,
    targetId: plan.targetId,
    steps: plan.steps,
    cleanup: plan.cleanup,
    resources: plan.resources,
    risk: plan.risk,
    // Where the steps run changes the blast radius, so it belongs in the digest:
    // a plan must not be re-pointed at another host without a new fingerprint.
    transport: plan.transport ?? null,
  }
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

export type FingerprintMatch =
  | { ok: true }
  | {
      ok: false
      reason: 'expired' | 'identity-mismatch' | 'config-mismatch'
      changed: string[]
    }

/**
 * Compares the fingerprint recorded in the Plan with the live one.
 * Precedence: expired, then target identity, then configuration.
 */
export function matchFingerprint(
  plan: Plan,
  current: PlanFingerprint,
  now: string,
): FingerprintMatch {
  const planExpired = Date.parse(plan.fingerprint.expiresAt) <= Date.parse(now)
  const currentExpired = Date.parse(current.expiresAt) <= Date.parse(now)
  if (planExpired || currentExpired) {
    return { ok: false, reason: 'expired', changed: ['expiresAt'] }
  }

  if (plan.fingerprint.systemIdentifier !== current.systemIdentifier) {
    return { ok: false, reason: 'identity-mismatch', changed: ['systemIdentifier'] }
  }

  const changed: string[] = []
  if (plan.fingerprint.configDigest !== current.configDigest) changed.push('configDigest')
  if (plan.fingerprint.targetOid !== current.targetOid) changed.push('targetOid')
  if (changed.length > 0) {
    return { ok: false, reason: 'config-mismatch', changed }
  }

  return { ok: true }
}
