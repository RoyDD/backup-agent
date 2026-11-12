import { readdirSync, statSync } from 'node:fs'

import type { ArtifactId, AttemptId, OutboxId, TargetId } from '../domain/ids'
import { asArtifactId } from '../domain/ids'
import type { ErrorClass } from '../domain/errors'
import type { Plan } from '../domain/plan'
import { canTransitionAttempt, canTransitionTicket } from '../domain/state'
import { riskAtLeast } from '../domain/risk'
import { fingerprintPlan } from '../plan/fingerprint'
import { severityForFailure } from '../ops/notify'
import type { Repository } from '../ports/repository'
import type { RunPlanResult } from '../runner/run-plan'
import {
  DestructiveAuthorizationDeniedError,
  checkDestructiveAuthorization,
  type DestructiveAuthorizationInput,
} from '../security/destructive-authorization'
import { newId } from '../util/id'

/** Outbox topic for the retained, replayable run audit event. */
export const OUTBOX_TOPIC_RUN_AUDIT = 'audit.run'
/** Outbox topic for failure notifications (delivered to BKAGENT_WEBHOOK_URL). */
export const OUTBOX_TOPIC_RUN_FAILURE = 'notify.failure'

/** The lease a run operated under; only these fields are persisted. */
export interface RunLeaseRef {
  readonly targetId: TargetId
  readonly owner: string
  readonly token: number
  readonly expiresAt: string
}

export interface RunArtifactInput {
  readonly path: string
  readonly kind: string
  readonly verifiedLevel: string | null
  /** Measured by the caller when it already walked the path. */
  readonly sizeBytes?: number
}

export interface StartRunInput {
  readonly plan: Plan
  readonly principalId: string
  readonly lease: RunLeaseRef
  readonly attemptId: AttemptId
  readonly now: string
  /**
   * Destructive authorization facts rechecked inside the start transaction.
   *
   * Required for any plan at or above `destructive`: the CLI gate runs before
   * the lease is taken, and an approval can be rejected or the asset row moved
   * to another environment in between. Omitted for ordinary plans.
   */
  readonly authorization?: DestructiveAuthorizationInput
}

export type StartRunOutcome =
  | { readonly started: true }
  | { readonly started: false; readonly reason: string }

export interface FinishRunInput {
  readonly plan: Plan
  readonly result: RunPlanResult
  readonly lease: RunLeaseRef | null
  readonly attemptId: AttemptId
  readonly now: string
  readonly artifact?: RunArtifactInput
}

export type FinishRunOutcome =
  | { readonly persisted: true; readonly outboxIds: readonly OutboxId[] }
  | { readonly persisted: false; readonly reason: string }

/**
 * Raised when the run's fencing token was superseded before its terminal
 * transaction; nothing the run writes may commit.
 */
export class StaleLeaseFenceError extends Error {
  constructor(
    readonly targetId: TargetId,
    readonly heldToken: number,
    readonly currentToken: number,
  ) {
    super(
      `lease fence for "${targetId}" advanced from ${heldToken} to ${currentToken}; ` +
        'the run no longer holds execution authority',
    )
    this.name = 'StaleLeaseFenceError'
  }
}

/**
 * Raised when the stored lease no longer matches the run's owner/token or has
 * expired, even though the fence counter did not move (no successor acquired
 * the target yet).
 */
export class LeaseNotLiveError extends Error {
  constructor(
    readonly targetId: TargetId,
    lease: RunLeaseRef,
    detail: string,
  ) {
    super(
      `lease ${lease.token} on "${targetId}" held by ${lease.owner} ${detail}; ` +
        'the run no longer holds execution authority',
    )
    this.name = 'LeaseNotLiveError'
  }
}

function pathSize(path: string): number {
  try {
    const stats = statSync(path)
    if (stats.isFile()) return stats.size
    let total = 0
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`
      total += entry.isDirectory() ? pathSize(child) : statSync(child).size
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Persists the Ticket/Plan/Attempt envelope a run is about to execute, using
 * the Plan's own `ticketId` and `mandateId` — the same identities its lineage
 * and audit events reference.
 *
 * Call this *before* any subprocess is dispatched and while the lease is still
 * held; `executePlan` runs it in the same `BEGIN IMMEDIATE` transaction as lease
 * acquisition. The fence, the stored lease row and its expiry are all checked
 * before any row is written: an expired lease is never authority to start a
 * run, even if no successor has taken it over yet. The start write never
 * renews the lease, and a failure means no step may run.
 *
 * For plans at or above `destructive`, the authorization decision is recomputed
 * from the control database in this same transaction, immediately before the
 * envelope is written. A denial throws
 * {@link DestructiveAuthorizationDeniedError} so the caller's transaction —
 * including the lease it just acquired — rolls back, leaving no rows.
 */
export async function startRun(repo: Repository, input: StartRunInput): Promise<StartRunOutcome> {
  try {
    return await repo.transaction((tx) => startRunInTransaction(tx, input))
  } catch (error) {
    if (error instanceof DestructiveAuthorizationDeniedError) {
      return { started: false, reason: error.message }
    }
    throw error
  }
}

/** Transaction-bound form of {@link startRun} for callers that already hold one. */
export async function startRunInTransaction(
  tx: Repository,
  input: StartRunInput,
): Promise<StartRunOutcome> {
  const { plan, lease, now } = input
  const fence = await tx.leases.currentFence(plan.targetId)
  if (fence !== lease.token) return { started: false, reason: new StaleLeaseFenceError(plan.targetId, lease.token, fence).message }

  const current = await tx.leases.get(plan.targetId)
  if (current === null || current.owner !== lease.owner || current.token !== lease.token) {
    return {
      started: false,
      reason: new LeaseNotLiveError(plan.targetId, lease, 'is no longer held').message,
    }
  }
  if (!(current.expiresAt > now)) {
    return {
      started: false,
      reason: new LeaseNotLiveError(plan.targetId, lease, `expired at ${current.expiresAt} (now ${now})`)
        .message,
    }
  }

  // Final gate: the authorization state that justified the CLI gate can change
  // between that gate and this transaction (a later reject, an asset moved to
  // production). Recheck it here, before the envelope and before any argv can
  // reach an executor. A denial throws so nothing commits.
  let recordedPlan = plan
  if (riskAtLeast(plan.risk, 'destructive')) {
    if (input.authorization === undefined) {
      throw new DestructiveAuthorizationDeniedError(
        'authorization-required',
        `${plan.risk} plan on target "${plan.targetId}" was started without an authorization ` +
          'recheck; destructive plans require --yes, an exact asset and current approvals at ' +
          'start time',
      )
    }
    const authorization = await checkDestructiveAuthorization(
      tx,
      plan,
      input.authorization,
      new Date(now),
    )
    if (!authorization.allowed) {
      throw new DestructiveAuthorizationDeniedError(authorization.reason, authorization.message)
    }
    // Record the risk the current asset justifies, never one lower than the plan.
    if (authorization.effectiveRisk !== plan.risk) {
      recordedPlan = { ...plan, risk: authorization.effectiveRisk }
    }
  }

  await tx.tickets.insert({
    id: recordedPlan.ticketId,
    principalId: input.principalId,
    targetId: recordedPlan.targetId,
    goal: `${recordedPlan.provider} ${recordedPlan.risk}`,
    state: 'in_progress',
    createdAt: now,
    updatedAt: now,
  })
  await tx.mandates.insert({
    id: recordedPlan.mandateId,
    ticketId: recordedPlan.ticketId,
    principalId: input.principalId,
    scope: recordedPlan.provider,
    policyVersion: 'cli',
    allowedRisk: recordedPlan.risk,
    issuedAt: now,
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
  })
  await tx.plans.insert({
    id: recordedPlan.planId,
    ticketId: recordedPlan.ticketId,
    mandateId: recordedPlan.mandateId,
    state: 'dispatched',
    payload: recordedPlan,
    fingerprintDigest: fingerprintPlan(recordedPlan),
    createdAt: now,
    updatedAt: now,
  })
  await tx.attempts.insert({
    id: input.attemptId,
    planId: recordedPlan.planId,
    state: 'running',
    owner: lease.owner,
    leaseToken: lease.token,
    leaseExpiresAt: lease.expiresAt,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    errorClass: null,
    targetId: recordedPlan.targetId,
  })

  // Durable trace of the dispatch itself: lineage and an audit event commit with
  // the envelope, so a crash after this point still leaves a record of what ran.
  await tx.lineage.append({
    fromKind: 'ticket',
    fromId: recordedPlan.ticketId,
    toKind: 'plan',
    toId: recordedPlan.planId,
    relation: 'spawned',
    createdAt: now,
  })
  await tx.lineage.append({
    fromKind: 'plan',
    fromId: recordedPlan.planId,
    toKind: 'attempt',
    toId: input.attemptId,
    relation: 'attempted',
    createdAt: now,
  })
  await tx.outbox.append({
    topic: OUTBOX_TOPIC_RUN_AUDIT,
    payload: startAuditPayload(input, recordedPlan),
    idempotencyKey: `run:${recordedPlan.planId}:${input.attemptId}:start`,
    availableAt: now,
  })

  return { started: true }
}

/**
 * Records the terminal state of a run, guarded by the lease fence *and* the
 * live lease row.
 *
 * Everything happens in one short `BEGIN IMMEDIATE` transaction: the guard,
 * the attempt/ticket/artifact writes, the attempt→artifact lineage edge and the
 * Outbox audit (plus failure-notification) events commit together or not at
 * all. The ticket→plan and plan→attempt edges belong to the start transaction,
 * so a crash before this point still has a lineage record. No transaction is
 * held across external work; the caller invokes this only after the executor
 * returned.
 *
 * `lease-lost`, a missing lease, and a superseded or expired lease write
 * nothing at all: the attempt is left `running` for reconciliation, which owns
 * deciding that the lease is gone.
 */
export async function finishRun(repo: Repository, input: FinishRunInput): Promise<FinishRunOutcome> {
  if (input.result.status === 'lease-lost') {
    return { persisted: false, reason: 'lease was lost during execution' }
  }
  if (input.lease === null) {
    return { persisted: false, reason: 'plan never held an execution lease' }
  }
  try {
    return await repo.transaction((tx) => finishRunInTransaction(tx, input))
  } catch (error) {
    if (error instanceof StaleLeaseFenceError || error instanceof LeaseNotLiveError) {
      return { persisted: false, reason: error.message }
    }
    throw error
  }
}

/**
 * Transaction-bound form of {@link finishRun}. Exposed so a caller (and tests)
 * can compose the terminal writes with other work in one transaction; the
 * caller owns commit/rollback.
 */
export async function finishRunInTransaction(
  repo: Repository,
  input: FinishRunInput,
): Promise<FinishRunOutcome> {
  if (input.result.status === 'lease-lost') {
    return { persisted: false, reason: 'lease was lost during execution' }
  }
  const lease = input.lease
  if (lease === null || lease === undefined) {
    return { persisted: false, reason: 'plan never held an execution lease' }
  }
  const { plan, result, attemptId, now } = input

  const fence = await repo.leases.currentFence(plan.targetId)
  if (fence !== lease.token) {
    // Throwing rolls the transaction back: a superseded worker commits nothing.
    throw new StaleLeaseFenceError(plan.targetId, lease.token, fence)
  }
  const current = await repo.leases.get(plan.targetId)
  if (current === null) {
    throw new LeaseNotLiveError(plan.targetId, lease, 'is no longer held')
  }
  if (current.owner !== lease.owner || current.token !== lease.token) {
    throw new LeaseNotLiveError(plan.targetId, lease, 'was taken over')
  }
  if (!(current.expiresAt > now)) {
    throw new LeaseNotLiveError(plan.targetId, lease, `expired at ${current.expiresAt} (now ${now})`)
  }

  const attempt = await repo.attempts.get(attemptId)
  if (attempt === null) throw new Error(`attempt not found: ${attemptId}`)
  const terminalState = result.status === 'succeeded' ? 'succeeded' : 'failed'
  if (!canTransitionAttempt(attempt.state, terminalState)) {
    return {
      persisted: false,
      reason: `attempt ${attemptId} is ${attempt.state} and cannot become ${terminalState}`,
    }
  }

  const failedStep = result.steps.find((step) => step.status === 'failed')
  const exitCode = result.status === 'succeeded' ? 0 : (failedStep?.exitCode ?? null)
  const errorClass =
    result.status === 'succeeded'
      ? null
      : (result.errorClass ?? failedStep?.errorClass ?? 'permanent')

  await repo.attempts.updateState(attemptId, terminalState, {
    finishedAt: now,
    leaseExpiresAt: null,
    exitCode,
    errorClass,
  })

  const ticket = await repo.tickets.get(plan.ticketId)
  if (ticket !== null && canTransitionTicket(ticket.state, terminalState)) {
    await repo.tickets.updateState(plan.ticketId, terminalState, now)
  }

  let artifactId: ArtifactId | null = null
  if (input.artifact !== undefined && result.status === 'succeeded') {
    artifactId = asArtifactId(newId('art'))
    await repo.artifacts.insert({
      id: artifactId,
      planId: plan.planId,
      targetId: plan.targetId,
      provider: plan.provider,
      kind: input.artifact.kind,
      parentId: null,
      path: input.artifact.path,
      sizeBytes: input.artifact.sizeBytes ?? pathSize(input.artifact.path),
      checksum: null,
      verifiedLevel: input.artifact.verifiedLevel,
      verifiedAt: input.artifact.verifiedLevel === null ? null : now,
      protected: false,
      createdAt: now,
    })
  }

  if (artifactId !== null) {
    await repo.lineage.append({
      fromKind: 'attempt',
      fromId: attemptId,
      toKind: 'artifact',
      toId: artifactId,
      relation: 'produced',
      createdAt: now,
    })
  }

  const audit = await repo.outbox.append({
    topic: OUTBOX_TOPIC_RUN_AUDIT,
    payload: auditPayload(input, artifactId, exitCode, errorClass),
    idempotencyKey: `run:${plan.planId}:${attemptId}:audit`,
    availableAt: now,
  })
  const outboxIds: OutboxId[] = [audit.id]

  if (result.status === 'failed') {
    const notification = await repo.outbox.append({
      topic: OUTBOX_TOPIC_RUN_FAILURE,
      payload: failurePayload(input, errorClass, exitCode),
      idempotencyKey: `run:${plan.planId}:${attemptId}:notify`,
      availableAt: now,
    })
    outboxIds.push(notification.id)
  }

  return { persisted: true, outboxIds }
}

function startAuditPayload(input: StartRunInput, plan: Plan): Record<string, unknown> {
  return {
    event: 'run.started',
    planId: plan.planId,
    ticketId: plan.ticketId,
    mandateId: plan.mandateId,
    targetId: plan.targetId,
    attemptId: input.attemptId,
    engine: plan.engine,
    provider: plan.provider,
    risk: plan.risk,
    lease: { owner: input.lease.owner, token: input.lease.token },
    startedAt: input.now,
  }
}

function auditPayload(
  input: FinishRunInput,
  artifactId: ArtifactId | null,
  exitCode: number | null,
  errorClass: string | null,
): Record<string, unknown> {
  const { plan, result, lease, attemptId, now } = input
  return {
    event: 'run.finished',
    planId: plan.planId,
    ticketId: plan.ticketId,
    mandateId: plan.mandateId,
    targetId: plan.targetId,
    attemptId,
    engine: plan.engine,
    provider: plan.provider,
    risk: plan.risk,
    status: result.status,
    errorClass,
    failedStep: result.failedStep ?? null,
    exitCode,
    artifactId,
    lease: lease === null ? null : { owner: lease.owner, token: lease.token },
    steps: result.steps.map((step) => ({
      stepId: step.stepId,
      status: step.status,
      attempts: step.attempts,
      exitCode: step.exitCode,
    })),
    recordedAt: now,
  }
}

function failurePayload(
  input: FinishRunInput,
  errorClass: string | null,
  exitCode: number | null,
): Record<string, unknown> {
  const { plan, result, attemptId } = input
  return {
    severity: severityForFailure((errorClass ?? 'permanent') as ErrorClass),
    title: `backup failed: ${plan.provider}`,
    message:
      result.error ??
      (result.failedStep === undefined ? 'run failed' : `step ${result.failedStep} failed`),
    labels: {
      targetId: plan.targetId,
      planId: plan.planId,
      attemptId,
    },
    details: {
      errorClass,
      failedStep: result.failedStep ?? null,
      exitCode,
    },
  }
}
