import type { Plan, PlanFingerprint } from '../domain/plan'
import { rebasePlan } from './rebase'
import type { PlanValidationIssue } from './validate'

export type PreparePlanResult =
  | { ok: true; plan: Plan; attempts: number }
  | {
      ok: false
      reason: 'identity-changed' | 'validation-failed'
      issues: PlanValidationIssue[]
      plan: Plan
      attempts: number
    }

export interface PreparePlanOptions {
  plan: Plan
  /** Probe the live target and return its current fingerprint. */
  refresh: (attempt: number) => Promise<PlanFingerprint>
  validate: (plan: Plan) => PlanValidationIssue[]
  now: () => string
  maxAttempts?: number
}

/**
 * Plan/Apply gate with bounded re-planning. Each attempt refreshes the live
 * fingerprint, rebases, and re-validates. Identity drift aborts immediately;
 * fingerprint expiry or configuration drift may re-plan up to the limit.
 */
export async function preparePlan(options: PreparePlanOptions): Promise<PreparePlanResult> {
  const maxAttempts = options.maxAttempts ?? 2
  let plan = options.plan
  let issues: PlanValidationIssue[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await options.refresh(attempt)
    const rebased = rebasePlan(plan, current, options.now())

    if (rebased.kind === 'abort') {
      return {
        ok: false,
        reason: 'identity-changed',
        issues: [
          {
            code: 'FINGERPRINT',
            path: 'fingerprint.systemIdentifier',
            message: 'target identity changed since the plan was built',
          },
        ],
        plan,
        attempts: attempt,
      }
    }
    if (rebased.kind === 'replan') plan = rebased.plan

    issues = options.validate(plan)
    if (issues.length === 0) return { ok: true, plan, attempts: attempt }

    const onlyFingerprint = issues.every((issue) => issue.code === 'FINGERPRINT')
    if (!onlyFingerprint) break
  }

  return { ok: false, reason: 'validation-failed', issues, plan, attempts: maxAttempts }
}
