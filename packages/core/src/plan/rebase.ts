import { asPlanId } from '../domain/ids'
import type { Plan, PlanFingerprint } from '../domain/plan'
import { newId } from '../util/id'
import { matchFingerprint } from './fingerprint'

export type RebaseResult =
  | { kind: 'unchanged' }
  | { kind: 'abort'; reason: 'target-identity-changed'; changed: string[] }
  | { kind: 'replan'; plan: Plan; reason: 'config-changed' | 'fingerprint-expired' }

/**
 * Re-evaluates a Plan against the live fingerprint.
 * A changed target identity always aborts; configuration drift or an expired
 * fingerprint produces a new Plan revision and supersedes the previous one.
 */
export function rebasePlan(plan: Plan, current: PlanFingerprint, now: string): RebaseResult {
  if (plan.fingerprint.systemIdentifier !== current.systemIdentifier) {
    return {
      kind: 'abort',
      reason: 'target-identity-changed',
      changed: ['systemIdentifier'],
    }
  }

  const match = matchFingerprint(plan, current, now)
  if (match.ok) return { kind: 'unchanged' }

  return {
    kind: 'replan',
    reason: match.reason === 'expired' ? 'fingerprint-expired' : 'config-changed',
    plan: {
      ...plan,
      planId: asPlanId(newId('pln')),
      fingerprint: current,
    },
  }
}
