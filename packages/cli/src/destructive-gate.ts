import { existsSync } from 'node:fs'

import { OUTBOX_TOPIC_RUN_AUDIT, createSqliteRepository } from '@backup-agent/core/persistence'
import {
  APPROVAL_TTL_MS,
  escalateRisk,
  fourEyesStatus,
  requiredApprovals,
  riskAtLeast,
  type ApprovalRecord,
  type AssetDescriptor,
  type InstanceInfo,
  type Plan,
  type RiskLevel,
} from '@backup-agent/core'

/**
 * Central authorization gate for destructive CLI plans.
 *
 * Every command whose Plan can reach `destructive` routes through
 * `authorizeDestructivePlan` immediately before execution. The gate is
 * fail-closed: a destructive plan is rejected unless the control database
 * holds an exact asset for `plan.targetId`, the operator passed `--yes`, the
 * target identity is proven by the live probe, and any required four-eyes
 * approvals are current and bound to this plan's configuration digest.
 */
export const DESTRUCTIVE_PLAN_COMMANDS = [
  'restore',
  'pitr',
  'pgbackrest-restore',
  'pgbackrest-expire',
  'walg-restore',
  'walg-prune',
] as const

export type DestructivePlanCommand = (typeof DESTRUCTIVE_PLAN_COMMANDS)[number]

export type DestructiveDenialReason =
  | 'confirmation-required'
  | 'control-db-unavailable'
  | 'asset-unregistered'
  | 'identity-unproven'
  | 'approvals-insufficient'
  | 'risk-understated'

export interface DestructiveGateInput {
  /** Plan as built by the provider, before execution. */
  readonly plan: Plan
  /** Live probe result used to build the plan. */
  readonly instance: InstanceInfo
  /** Resolved control database path (`--db`, `BKAGENT_DB`, then default). */
  readonly controlDb: string
  /** `--yes` flag. */
  readonly confirmed: boolean
  /** Effective CLI principal that will execute the plan. */
  readonly requester: string
  /** OS-derived principal, kept separate so `--principal` cannot dodge self-approval. */
  readonly osPrincipal: string
  readonly now?: Date
}

export type DestructiveGateResult =
  | {
      kind: 'allowed'
      plan: Plan
      /** Registered asset when the plan was destructive; null for reversible plans. */
      asset: AssetDescriptor | null
      /** Risk after asset escalation. */
      effectiveRisk: RiskLevel
    }
  | {
      kind: 'denied'
      /** 2 for operator-actionable refusals, 4 for unproven identity or control DB failure. */
      exitCode: 2 | 4
      reason: DestructiveDenialReason
      message: string
    }

function denied(
  exitCode: 2 | 4,
  reason: DestructiveDenialReason,
  message: string,
): DestructiveGateResult {
  return { kind: 'denied', exitCode, reason, message }
}

/**
 * Durable record of a refused authorization (E-03: an unauthorized attempt must
 * leave an audit trail even though nothing was executed). The outbox row is the
 * retained audit copy; the dispatcher's audit handler confirms it without any
 * external I/O.
 *
 * Best effort by design: a missing or unreadable control database must not turn
 * a refusal into a crash, and the refusal stays the primary outcome. A missing
 * `--yes` is a usage slip rather than an authorization failure, so that branch
 * is not recorded.
 */
async function recordDenial(
  input: DestructiveGateInput,
  reason: DestructiveDenialReason,
  detail: string,
): Promise<void> {
  try {
    if (!existsSync(input.controlDb)) return
    const now = (input.now ?? new Date()).toISOString()
    const repo = await createSqliteRepository({ filename: input.controlDb })
    try {
      await repo.migrate()
      await repo.outbox.append({
        topic: OUTBOX_TOPIC_RUN_AUDIT,
        payload: {
          event: 'authorization.denied',
          reason,
          detail,
          planId: input.plan.planId,
          targetId: input.plan.targetId,
          risk: input.plan.risk,
          requester: input.requester,
          osPrincipal: input.osPrincipal,
          detectedAt: now,
        },
        idempotencyKey: `authz-denied:${input.plan.planId}:${reason}:${now}`,
        availableAt: now,
      })
    } finally {
      await repo.close()
    }
  } catch {
    // The refusal is the outcome; never mask it with an audit failure.
  }
}

/**
 * A probe that cannot read `pg_control_system()` yields a null system
 * identifier; the provider then records `unavailable:<target>` in the plan
 * fingerprint. Neither proves which cluster will be modified.
 */
export function provenIdentity(plan: Plan, instance: InstanceInfo): string | null {
  const live = instance.systemIdentifier
  if (live === null || live.trim() === '') return null
  const planned = plan.fingerprint.systemIdentifier
  if (planned !== live || planned.startsWith('unavailable:')) return null
  return live
}

/** Shared refusal text; also used when a destructive plan's refresh probe fails. */
export function identityDenialMessage(plan: Plan, instance: InstanceInfo): string {
  return (
    `cannot prove target identity for destructive plan on "${plan.targetId}": ` +
    `plan systemIdentifier=${plan.fingerprint.systemIdentifier}, ` +
    `live systemIdentifier=${instance.systemIdentifier ?? 'unavailable'}. ` +
    'Probe the target with --dsn or BKAGENT_DSN and retry; destructive plans are not ' +
    'executed against an unproven identity.'
  )
}

function unregisteredAsset(targetId: string, controlDb: string): DestructiveGateResult {
  return denied(
    2,
    'asset-unregistered',
    `no asset registered for target "${targetId}" in control database "${controlDb}". ` +
      'Register it before destructive work:\n' +
      `  bkagent asset-set --db ${controlDb} --target ${targetId} --engine postgres ` +
      '--environment <production|staging|development|test> --owner <owner> ' +
      '--criticality <critical|high|medium|low> ' +
      '--data-classification <public|internal|confidential|restricted> ' +
      '--rpo-minutes <n> --rto-minutes <n> [--protected]',
  )
}

export async function authorizeDestructivePlan(
  input: DestructiveGateInput,
): Promise<DestructiveGateResult> {
  const now = input.now ?? new Date()
  const targetId = input.plan.targetId

  // Every caller is a command whose Plan must be destructive
  // (`DESTRUCTIVE_PLAN_COMMANDS`). A plan arriving with a lower label is either
  // mis-built or deliberately understated, so its own risk field cannot be
  // trusted to decide that it needs no authorization: refuse instead of
  // executing an unlabelled destructive step.
  if (!riskAtLeast(input.plan.risk, 'destructive')) {
    const detail = `plan declares risk "${input.plan.risk}"`
    await recordDenial(input, 'risk-understated', detail)
    return denied(
      4,
      'risk-understated',
      `refusing a ${input.plan.risk} plan for target "${targetId}": this command only runs ` +
        `destructive plans, and the plan label cannot be trusted to skip approval. ` +
        `Re-plan with the provider that owns the target.`,
    )
  }

  if (!input.confirmed) {
    return denied(
      2,
      'confirmation-required',
      `plan risk is ${input.plan.risk} for target "${targetId}"; re-run with --yes to proceed`,
    )
  }

  if (provenIdentity(input.plan, input.instance) === null) {
    await recordDenial(input, 'identity-unproven', identityDenialMessage(input.plan, input.instance))
    return denied(4, 'identity-unproven', identityDenialMessage(input.plan, input.instance))
  }

  if (!existsSync(input.controlDb)) {
    await recordDenial(input, 'asset-unregistered', 'asset lookup: no control database')
    return unregisteredAsset(targetId, input.controlDb)
  }

  let asset: AssetDescriptor | null
  let approvals: ApprovalRecord[] = []
  const digest = input.plan.fingerprint.configDigest
  try {
    const repo = await createSqliteRepository({ filename: input.controlDb })
    await repo.migrate()
    try {
      asset = await repo.assets.get(targetId)
      if (asset !== null && requiredApprovals(escalateRisk(input.plan.risk, asset)) > 0) {
        const since = new Date(now.getTime() - APPROVAL_TTL_MS).toISOString()
        approvals = await repo.approvals.listFor(targetId, digest, since)
      }
    } finally {
      await repo.close()
    }
  } catch (error) {
    return denied(
      4,
      'control-db-unavailable',
      `cannot read control database "${input.controlDb}" for target "${targetId}": ${
        (error as Error).message
      }`,
    )
  }

  if (asset === null) {
    await recordDenial(input, 'asset-unregistered', `no asset registered for "${targetId}"`)
    return unregisteredAsset(targetId, input.controlDb)
  }

  const effectiveRisk = escalateRisk(input.plan.risk, asset)
  const gatedPlan: Plan =
    effectiveRisk === input.plan.risk ? input.plan : { ...input.plan, risk: effectiveRisk }

  const required = requiredApprovals(effectiveRisk)
  if (required === 0) {
    return { kind: 'allowed', plan: gatedPlan, asset, effectiveRisk }
  }

  const status = fourEyesStatus(effectiveRisk, approvals, now, APPROVAL_TTL_MS, [
    input.requester,
    input.osPrincipal,
  ])
  if (status.ok) {
    return { kind: 'allowed', plan: gatedPlan, asset, effectiveRisk }
  }

  const selfNote =
    status.selfApproved === undefined
      ? ''
      : `\nignored self-approval from requester: ${status.selfApproved.join(', ')}`
  await recordDenial(
    input,
    'approvals-insufficient',
    `${effectiveRisk} plan requires ${status.required} distinct approvals; have ${status.distinct}`,
  )
  return denied(
    2,
    'approvals-insufficient',
    `${effectiveRisk} plan on target "${targetId}" requires ${status.required} distinct ` +
      `approvals; have ${status.distinct}.${selfNote}\n` +
      `control database: ${input.controlDb}\n` +
      `digest: ${digest}\n` +
      `approve: bkagent approve --db ${input.controlDb} --target ${targetId} ` +
      `--digest ${digest} --approver <id>\n` +
      `inspect: bkagent approvals --db ${input.controlDb} --target ${targetId} --digest ${digest}`,
  )
}
