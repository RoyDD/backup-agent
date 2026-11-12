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
}

/** Production-destructive plans require two distinct approvers. */
export function requiredApprovals(risk: RiskLevel): number {
  return risk === 'production-destructive' ? 2 : 0
}

/**
 * A destructive restore against a protected production asset is escalated to
 * production-destructive, which puts it behind four-eyes approval.
 */
export function escalateRisk(base: RiskLevel, asset: AssetDescriptor | null): RiskLevel {
  if (
    asset !== null &&
    asset.environment === 'production' &&
    asset.protected &&
    base === 'destructive'
  ) {
    return 'production-destructive'
  }
  return base
}

export function fourEyesStatus(
  risk: RiskLevel,
  approvals: readonly ApprovalLike[],
  now: Date,
  ttlMs = 3_600_000,
): FourEyesStatus {
  const required = requiredApprovals(risk)
  if (required === 0) return { required: 0, distinct: 0, ok: true }

  const since = now.getTime() - ttlMs
  const approvers = new Set(
    approvals
      .filter(
        (approval) =>
          approval.decision === 'approve' && Date.parse(approval.createdAt) >= since,
      )
      .map((approval) => approval.approver),
  )

  return approvers.size >= required
    ? { required, distinct: approvers.size, ok: true }
    : { required, distinct: approvers.size, ok: false, reason: 'insufficient-approvals' }
}
