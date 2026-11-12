import type { AssetDescriptor } from '../domain/asset'
import type { Plan } from '../domain/plan'
import { riskAtLeast, type RiskLevel } from '../domain/risk'
import type { Repository } from '../ports/repository'
import { APPROVAL_TTL_MS, escalateRisk, fourEyesStatus, requiredApprovals } from './four-eyes'

/**
 * Why a destructive plan was refused at the execution seam. The CLI gate has
 * richer reasons (identity, control DB); these are the ones that can change
 * between that gate and the start transaction.
 */
export type DestructiveAuthorizationDeniedReason =
  | 'authorization-required'
  | 'confirmation-required'
  | 'asset-unregistered'
  | 'approvals-insufficient'

/** Operator-supplied authorization facts, re-read against the live control DB. */
export interface DestructiveAuthorizationInput {
  /** `--yes`. */
  readonly confirmed: boolean
  /** Effective CLI principal that will run the plan (may be `--principal`). */
  readonly requester: string
  /** OS-derived principal, excluded separately so `--principal` cannot dodge four eyes. */
  readonly osPrincipal: string
  /** Approval freshness window; defaults to {@link APPROVAL_TTL_MS}. */
  readonly approvalTtlMs?: number
}

export type DestructiveAuthorizationCheck =
  | {
      readonly allowed: true
      /** Registered asset the decision was made against; null for ungated plans. */
      readonly asset: AssetDescriptor | null
      /** Risk after escalation against the *current* asset environment. */
      readonly effectiveRisk: RiskLevel
      readonly required: number
      readonly distinct: number
    }
  | {
      readonly allowed: false
      readonly reason: DestructiveAuthorizationDeniedReason
      readonly effectiveRisk: RiskLevel
      readonly message: string
    }

/**
 * Raised when the destructive authorization state no longer holds at the
 * execution seam. Throwing is deliberate: the start transaction has already
 * acquired the lease, so the caller must roll it back rather than commit a
 * lease/fence bump for a run that will never be dispatched.
 */
export class DestructiveAuthorizationDeniedError extends Error {
  constructor(
    readonly reason: DestructiveAuthorizationDeniedReason,
    message: string,
  ) {
    super(message)
    this.name = 'DestructiveAuthorizationDeniedError'
  }
}

function unregisteredAssetMessage(targetId: string): string {
  return (
    `no asset registered for target "${targetId}", so the plan cannot be authorized against ` +
    'its current environment. Register it before destructive work:\n' +
    '  bkagent asset-set --db <control-db> --target ' +
    `${targetId} --engine postgres --environment <production|staging|development|test> ` +
    '--owner <owner> --criticality <critical|high|medium|low> ' +
    '--data-classification <public|internal|confidential|restricted> ' +
    '--rpo-minutes <n> --rto-minutes <n> [--protected]'
  )
}

/**
 * Recomputes the destructive authorization decision from the control database
 * state visible to `tx`, immediately before a run envelope is written.
 *
 * The CLI probes target identity and gates the plan against a fresh probe; that
 * probe cannot move into this SQLite transaction without mixing an external
 * round trip into the write lock. What must move here is everything that lives
 * in the control DB and can change between the gate and the first subprocess:
 *
 *   - `--yes` (the caller could have been invoked without it);
 *   - the exact asset row for `plan.targetId`;
 *   - the effective risk, escalated from the *current* asset environment, so a
 *     target promoted to production after the gate requires two approvals even
 *     when it was approved as a staging target;
 *   - the latest approval decisions for the plan's config digest, excluding the
 *     requester and the OS principal.
 *
 * Read-only and reversible plans are not gated. Callers must invoke this inside
 * the same transaction that acquires the lease and writes the run envelope.
 */
export async function checkDestructiveAuthorization(
  tx: Repository,
  plan: Plan,
  input: DestructiveAuthorizationInput,
  now: Date,
): Promise<DestructiveAuthorizationCheck> {
  if (!riskAtLeast(plan.risk, 'destructive')) {
    // Ordinary plans are not gated at this seam.
    return {
      allowed: true,
      asset: null,
      effectiveRisk: plan.risk,
      required: 0,
      distinct: 0,
    }
  }

  if (!input.confirmed) {
    return {
      allowed: false,
      reason: 'confirmation-required',
      effectiveRisk: plan.risk,
      message:
        `plan risk is ${plan.risk} for target "${plan.targetId}"; re-run with --yes to proceed`,
    }
  }

  const asset = await tx.assets.get(plan.targetId)
  if (asset === null) {
    return {
      allowed: false,
      reason: 'asset-unregistered',
      effectiveRisk: plan.risk,
      message: unregisteredAssetMessage(plan.targetId),
    }
  }

  // Never downgrade: a plan already recorded as production-destructive stays so
  // even if the asset row was moved back to a lower environment.
  const effectiveRisk = escalateRisk(plan.risk, asset)
  const required = requiredApprovals(effectiveRisk)
  if (required === 0) {
    return { allowed: true, asset, effectiveRisk, required, distinct: 0 }
  }

  const ttlMs = input.approvalTtlMs ?? APPROVAL_TTL_MS
  const since = new Date(now.getTime() - ttlMs).toISOString()
  const digest = plan.fingerprint.configDigest
  const approvals = await tx.approvals.listFor(plan.targetId, digest, since)
  const status = fourEyesStatus(effectiveRisk, approvals, now, ttlMs, [
    input.requester,
    input.osPrincipal,
  ])
  if (status.ok) {
    return { allowed: true, asset, effectiveRisk, required, distinct: status.distinct }
  }

  const selfNote =
    status.selfApproved === undefined
      ? ''
      : `\nignored self-approval from requester: ${status.selfApproved.join(', ')}`
  return {
    allowed: false,
    reason: 'approvals-insufficient',
    effectiveRisk,
    message:
      `${effectiveRisk} plan on target "${plan.targetId}" requires ${status.required} distinct ` +
      `current approvals; have ${status.distinct}.${selfNote}\n` +
      `digest: ${digest}\n` +
      `approve: bkagent approve --db <control-db> --target ${plan.targetId} ` +
      `--digest ${digest} --approver <id>\n` +
      `inspect: bkagent approvals --db <control-db> --target ${plan.targetId} --digest ${digest}`,
  }
}
