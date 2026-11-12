import type { AssetDescriptor } from '../domain/asset'
import type { RiskLevel } from '../domain/risk'

export interface ApprovalLike {
  approver: string
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
 * Produces at most one decision per approver: the latest one wins. Records are
 * append-only, so a later reject supersedes an earlier approve and a later
 * approve supersedes an earlier reject. `approvals` must be ordered by
 * `createdAt` (the repository does this, with insertion order as tie-breaker);
 * equal timestamps resolve to the later entry.
 */
export function latestApprovalDecisions(
  approvals: readonly ApprovalLike[],
): Map<string, ApprovalLike> {
  const latest = new Map<string, ApprovalLike>()
  for (const approval of approvals) {
    const at = Date.parse(approval.createdAt)
    if (!Number.isFinite(at)) continue
    const previous = latest.get(approval.approver)
    if (previous === undefined || at >= Date.parse(previous.createdAt)) {
      latest.set(approval.approver, approval)
    }
  }
  return latest
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
 * identity is the CLI-derived principal, not a cryptographic claim; the gate
 * can only prevent an accidental self-approval, not collusion.
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

  for (const [approver, approval] of latestApprovalDecisions(approvals)) {
    const at = Date.parse(approval.createdAt)
    if (!Number.isFinite(at) || at > nowMs + MAX_CLOCK_SKEW_MS) continue
    if (approval.decision !== 'approve' || at < since) continue
    if (excluded.has(approver)) {
      selfApproved.push(approver)
      continue
    }
    approvers.add(approver)
  }

  const status: FourEyesStatus =
    approvers.size >= required
      ? { required, distinct: approvers.size, ok: true }
      : { required, distinct: approvers.size, ok: false, reason: 'insufficient-approvals' }

  return selfApproved.length === 0 ? status : { ...status, selfApproved }
}
