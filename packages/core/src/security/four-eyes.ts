import type { AssetDescriptor } from '../domain/asset'
import type { RiskLevel } from '../domain/risk'

export interface ApprovalLike {
  approver: string
  /**
   * Environment-derived identity captured with the approval. When non-empty it
   * is the identity four-eyes counts; `approver` is only a human label.
   */
  approverOs?: string | null
  decision: 'approve' | 'reject'
  createdAt: string
}

export interface FourEyesStatus {
  required: number
  distinct: number
  ok: boolean
  reason?: 'insufficient-approvals' | 'db-required'
  /**
   * Current approvals that were ignored because the approver is the requester.
   * Presence here does not fail the gate by itself; it explains the count.
   */
  selfApproved?: readonly string[]
}

/** Approvals older than this are stale and no longer authorize a plan. */
export const APPROVAL_TTL_MS = 3_600_000

/** Tolerated clock skew for approvals stamped slightly in the future. */
const MAX_CLOCK_SKEW_MS = 60_000

/**
 * Produces at most one decision per key: the latest one wins. Records are
 * append-only, so a later reject supersedes an earlier approve and a later
 * approve supersedes an earlier reject. `approvals` must be ordered by
 * `createdAt` (the repository does this, with insertion order as tie-breaker);
 * equal timestamps resolve to the later entry.
 */
function latestDecisionBy(
  approvals: readonly ApprovalLike[],
  keyOf: (approval: ApprovalLike) => string,
): Map<string, ApprovalLike> {
  const latest = new Map<string, ApprovalLike>()
  for (const approval of approvals) {
    const at = Date.parse(approval.createdAt)
    if (!Number.isFinite(at)) continue
    const key = keyOf(approval)
    const previous = latest.get(key)
    if (previous === undefined || at >= Date.parse(previous.createdAt)) {
      latest.set(key, approval)
    }
  }
  return latest
}

/**
 * One decision per `approver` label, latest wins. This is the label-keyed view
 * used by callers that only carry the human label; four-eyes itself resolves
 * per environment-derived identity.
 */
export function latestApprovalDecisions(
  approvals: readonly ApprovalLike[],
): Map<string, ApprovalLike> {
  return latestDecisionBy(approvals, (approval) => approval.approver)
}

/** Environment-derived identity when present, else the self-reported label. */
function approvalIdentity(approval: ApprovalLike): string {
  const osIdentity = approval.approverOs?.trim() ?? ''
  return osIdentity === '' ? approval.approver : osIdentity
}

/** Production-destructive plans require two distinct approvers. */
export function requiredApprovals(risk: RiskLevel): number {
  return risk === 'production-destructive' ? 2 : 0
}

/**
 * A destructive plan against a production asset requires two-person review.
 * `protected` governs retention immunity, not the approval threshold: a
 * production target without the protected flag still needs four eyes.
 */
export function escalateRisk(base: RiskLevel, asset: AssetDescriptor | null): RiskLevel {
  if (asset !== null && asset.environment === 'production' && base === 'destructive') {
    return 'production-destructive'
  }
  return base
}

/**
 * Counts distinct approvers whose *latest* decision is a current approve.
 *
 * `excludeApprovers` must carry the requester identity: an approval submitted
 * by the principal that will execute the plan cannot satisfy four eyes. The
 * identity counted is the environment-derived `approverOs` when present and
 * non-empty, otherwise the `approver` label; `approver` alone is self-reported,
 * so the gate can only prevent an accidental self-approval, not collusion. The
 * exclusion set is compared against both keys, so requester matching keeps
 * working for records that predate `approverOs`.
 */
export function fourEyesStatus(
  risk: RiskLevel,
  approvals: readonly ApprovalLike[],
  now: Date,
  ttlMs: number = APPROVAL_TTL_MS,
  excludeApprovers: readonly string[] = [],
): FourEyesStatus {
  const required = requiredApprovals(risk)
  if (required === 0) return { required: 0, distinct: 0, ok: true }

  const nowMs = now.getTime()
  const since = nowMs - ttlMs
  const excluded = new Set(excludeApprovers.filter((approver) => approver.trim() !== ''))
  const approvers = new Set<string>()
  const selfApproved: string[] = []

  for (const [identity, approval] of latestDecisionBy(approvals, approvalIdentity)) {
    const at = Date.parse(approval.createdAt)
    if (!Number.isFinite(at) || at > nowMs + MAX_CLOCK_SKEW_MS) continue
    if (approval.decision !== 'approve' || at < since) continue
    if (excluded.has(identity) || excluded.has(approval.approver)) {
      // Report the human label, as before; the OS identity is not evidence to expose.
      selfApproved.push(approval.approver)
      continue
    }
    approvers.add(identity)
  }

  const status: FourEyesStatus =
    approvers.size >= required
      ? { required, distinct: approvers.size, ok: true }
      : { required, distinct: approvers.size, ok: false, reason: 'insufficient-approvals' }

  return selfApproved.length === 0 ? status : { ...status, selfApproved }
}
