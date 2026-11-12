import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  DestructiveAuthorizationDeniedError,
  asAttemptId,
  asMandateId,
  asTicketId,
  newId,
  runPlan,
  validatePlan,
  type Capability,
  type AttemptId,
  type DestructiveAuthorizationInput,
  type Executor,
  type InstanceInfo,
  type LeaseRecord,
  type MandateRecord,
  type Plan,
  type PlanBuildContext,
  type PlanValidationIssue,
  type Repository,
  type RunPlanResult,
  type TargetId,
} from '@backup-agent/core'
import {
  createSqliteRepository,
  finishRun,
  startRunInTransaction,
  type FinishRunOutcome,
  type RunArtifactInput,
  type RunLeaseRef,
  type StartRunOutcome,
} from '@backup-agent/core/persistence'
import { postgresEngine } from '@backup-agent/engine-postgres'

/** Default lease TTL; heartbeats run at TTL/3 or faster. */
export const DEFAULT_LEASE_TTL_MS = 60_000

/** Control DB default, kept here so every plan path resolves it identically. */
export const DEFAULT_CONTROL_DB = '.bkagent/control.db'

/**
 * Shared plan execution seam for CLI run paths.
 *
 * Keeps plan scaffolding, validation, execution, single-target leasing and
 * outcome rendering in one place so authorization, lease handling and outcome
 * persistence cannot drift between commands. This module owns no
 * command-specific policy: callers still decide approval and confirmation
 * ordering before invoking it.
 *
 * Dependencies are passed in by callers; nothing here reaches back into the
 * CLI module.
 */
export interface PlanExecutionDeps {
  /** argv-only executor used for every step. */
  readonly executor: Executor
  /** Receives step lifecycle lines; the CLI passes its resolved stderr writer. */
  readonly writeError: (text: string) => void
  /**
   * Control database that holds execution leases. Every plan execution takes a
   * lease, including runs that never persist an outcome, so this is mandatory
   * and must be the resolved `--db` (or the CLI default).
   */
  readonly controlDb: string
  /** Principal used to derive the lease owner; defaults to `os` identity. */
  readonly principalId?: string
  readonly stateDir?: string
  /** Subprocess environment overlays (credentials never enter argv). */
  readonly env?: Readonly<Record<string, string>>
  readonly lease?: PlanLeaseOptions
  /** Deterministic clock seam (tests only). */
  readonly now?: () => string
  /**
   * Destructive authorization facts. Passed for every plan that can reach
   * `destructive`: the recheck runs inside the lease/start transaction, so a
   * reject or an asset change after the CLI gate still denies the run before
   * any subprocess is dispatched. Omitted for ordinary plans.
   */
  readonly authorization?: DestructiveAuthorizationInput
  /**
   * Artifact the run produced. Provider-managed backups pass nothing: the
   * provider owns its repository layout, so no local path is invented.
   */
  readonly artifact?: RunArtifactInput
  /**
   * Called with the terminal outcome after it has been persisted, while the
   * lease is still held. `attemptId` identifies the row the lifecycle recorded;
   * persistence itself is owned by this seam, not by individual commands.
   */
  readonly recordOutcome?: (
    result: RunPlanResult,
    lease: PlanLease,
    attemptId: AttemptId,
  ) => Promise<void>
}

export interface PlanLeaseOptions {
  /** Lease TTL. Defaults to {@link DEFAULT_LEASE_TTL_MS}. */
  readonly ttlMs?: number
  /** Renewal cadence, clamped to `ttlMs / 3`. */
  readonly heartbeatMs?: number
  /** Owner prefix; a PID and random per-invocation suffix are always appended. */
  readonly ownerPrefix?: string
}

/** Lease actually held while a plan ran. */
export interface PlanLease {
  readonly targetId: TargetId
  readonly owner: string
  readonly token: number
  readonly expiresAt: string
}

export interface PlanExecution {
  readonly result: RunPlanResult
  /**
   * The acquired lease, or null when acquisition was denied. Present on every
   * completed run; the lease is released before this value is returned, so the
   * token documents the fence the run operated under.
   */
  readonly lease: PlanLease | null
  /** Attempt row persisted before the first subprocess; null when denied or not started. */
  readonly attemptId: AttemptId | null
  /** Terminal persistence result; null when nothing was attempted. */
  readonly persistence: FinishRunOutcome | null
}

/** Builds the identity/timestamp envelope every provider plan needs. */
export function buildPlanContext(instance: InstanceInfo, digest: string): PlanBuildContext {
  const now = new Date().toISOString()
  return {
    ticketId: asTicketId(newId('tkt')),
    mandateId: asMandateId(newId('mnd')),
    now,
    instance,
    configDigest: digest,
  }
}

function mandateFor(plan: Plan, principalId: string): MandateRecord {
  const now = new Date().toISOString()
  return {
    id: plan.mandateId,
    ticketId: plan.ticketId,
    principalId,
    scope: plan.provider,
    policyVersion: 'cli',
    allowedRisk: plan.risk,
    issuedAt: now,
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
  }
}

/**
 * Validates a Plan against the declared engine capabilities and a CLI-issued
 * mandate. Returns issues instead of throwing so callers keep their existing
 * exit-code contract (4 for plan/probe failure).
 */
export function validateForExecution(
  plan: Plan,
  principalId: string,
  declaredCapabilities: ReadonlySet<Capability> = postgresEngine.capabilities,
): PlanValidationIssue[] {
  const now = new Date().toISOString()
  return validatePlan(plan, {
    now,
    declaredCapabilities,
    requiredCapabilities: [],
    mandate: mandateFor(plan, principalId),
    resources: { availableBytes: Number.MAX_SAFE_INTEGER, maxConcurrency: 8 },
    policyValid: true,
  })
}

/** Serializes validation issues for the CLI's existing JSON error payload. */
export function planIssueText(issues: readonly PlanValidationIssue[]): string {
  return JSON.stringify({ ok: false, issues }, null, 2)
}

/**
 * Lease owner for one run: `<prefix>:<pid>:<random>`.
 *
 * The random suffix is per invocation, so two processes started by the same
 * user (and even the same user-chosen `--principal`) never share an owner
 * identity; a constant owner would let a second run renew or release the first
 * run's lease.
 */
export function leaseOwner(prefix: string | undefined): string {
  const base = prefix === undefined || prefix.trim() === '' ? 'cli' : prefix.trim()
  return `${base}:${process.pid}:${newId('run')}`
}

interface LeaseHeartbeat {
  /** Clears the timer and awaits a renewal that is already in flight. */
  readonly stop: () => Promise<void>
}

function startLeaseHeartbeat(input: {
  readonly repo: Repository
  readonly lease: PlanLease
  readonly ttlMs: number
  readonly intervalMs: number
  readonly now: () => string
  readonly onLost: (reason: string) => void
}): LeaseHeartbeat {
  let lost = false
  let inFlight: Promise<void> | null = null
  const tick = (): void => {
    if (lost || inFlight !== null) return
    inFlight = (async () => {
      try {
        const renewed = await input.repo.leases.renew({
          targetId: input.lease.targetId,
          owner: input.lease.owner,
          token: input.lease.token,
          now: input.now(),
          ttlMs: input.ttlMs,
        })
        if (!renewed) {
          lost = true
          input.onLost(`lease ${input.lease.token} on ${input.lease.targetId} could not be renewed`)
        }
      } catch (error) {
        lost = true
        input.onLost(`lease renewal failed: ${(error as Error).message}`)
      } finally {
        inFlight = null
      }
    })()
  }

  const timer = setInterval(tick, input.intervalMs)
  // Never keep the process alive purely for a heartbeat.
  timer.unref()

  return {
    stop: async () => {
      clearInterval(timer)
      if (inFlight !== null) await inFlight
    },
  }
}

function leaseDenied(plan: Plan): RunPlanResult {
  return {
    planId: plan.planId,
    status: 'failed',
    steps: [],
    errorClass: 'permanent',
    error:
      `lease unavailable for target "${plan.targetId}": another run holds an unexpired lease; ` +
      'retry after it finishes or its TTL expires',
  }
}

/**
 * Result for a run whose terminal state could not be persisted authoritatively
 * (expired, superseded or otherwise stale lease). The command succeeded or
 * failed externally, but no authoritative terminal state exists, so the run must
 * never be reported as success.
 */
function runNotAuthoritative(plan: Plan, result: RunPlanResult, reason: string): RunPlanResult {
  return {
    planId: plan.planId,
    status: 'lease-lost',
    steps: result.steps,
    error: `terminal state was not persisted: ${reason}`,
    leaseLost: { phase: 'after-step', message: reason },
  }
}

/**
 * Result for a run whose start envelope could not be persisted. The lease was
 * acquired but no subprocess ran, and no attempt is left behind for reconcile.
 */
function startFailed(plan: Plan, reason: string): RunPlanResult {
  return {
    planId: plan.planId,
    status: 'failed',
    steps: [],
    errorClass: 'permanent',
    error: `run start was not persisted for target "${plan.targetId}": ${reason}`,
  }
}

/**
 * Result for a destructive plan whose authorization no longer holds when the
 * run was about to start. Nothing was written and no subprocess ran.
 */
function authorizationDenied(
  plan: Plan,
  denial: DestructiveAuthorizationDeniedError,
): RunPlanResult {
  return {
    planId: plan.planId,
    status: 'failed',
    steps: [],
    errorClass: 'permanent',
    error:
      `destructive authorization denied (${denial.reason}) for target ` +
      `"${plan.targetId}": ${denial.message}`,
  }
}

/**
 * Runs a validated Plan through the deterministic core under a single-target
 * lease.
 *
 * Scope of the lock is exactly `plan.targetId` — the provider-specific target
 * identity the Plan was built for. Two plans that describe the same PostgreSQL
 * cluster through different providers (or different data directories) have
 * different `targetId` values and are **not** serialized against each other;
 * the lease is not a cluster-wide mutex.
 *
 * Fencing guards control-plane commits only. The lease token fences this
 * process's writes to the control database; external PostgreSQL, `pgbackrest`
 * and `wal-g` processes are stopped on lease loss on a best-effort basis through
 * `AbortSignal`, and are never fenced at the provider.
 */
export async function executePlan(
  plan: Plan,
  instance: InstanceInfo,
  deps: PlanExecutionDeps,
): Promise<PlanExecution> {
  const now = deps.now ?? (() => new Date().toISOString())
  const ttlMs = deps.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS
  const maxInterval = Math.max(1, Math.floor(ttlMs / 3))
  const heartbeatMs = Math.min(deps.lease?.heartbeatMs ?? maxInterval, maxInterval)
  const owner = leaseOwner(deps.lease?.ownerPrefix ?? deps.principalId)
  const principalId = deps.principalId ?? 'cli'

  if (deps.controlDb !== ':memory:') mkdirSync(dirname(deps.controlDb), { recursive: true })
  const repo = await createSqliteRepository({ filename: deps.controlDb })

  let lease: PlanLease | null = null
  let attemptId: AttemptId | null = null
  try {
    await repo.migrate()
    // `transaction()` is SQLite `BEGIN IMMEDIATE`: the check-then-bump fence must
    // hold the write lock so a second process cannot acquire concurrently. The
    // run envelope is persisted in the same transaction, so there is no window
    // where a lease exists without the Attempt that documents it. The
    // destructive authorization recheck runs here too: a denial throws, rolling
    // back the lease rather than committing authority for a run that must not
    // start.
    let acquired: {
      held: LeaseRecord
      attemptId: AttemptId
      started: StartRunOutcome
    } | null = null
    let denial: DestructiveAuthorizationDeniedError | null = null
    try {
      acquired = await repo.transaction(async (tx) => {
        const held = await tx.leases.acquire({ targetId: plan.targetId, owner, now: now(), ttlMs })
        if (held === null) return null
        const id = asAttemptId(newId('att'))
        const started = await startRunInTransaction(tx, {
          plan,
          principalId,
          lease: held,
          attemptId: id,
          now: now(),
          ...(deps.authorization === undefined ? {} : { authorization: deps.authorization }),
        })
        return { held, attemptId: id, started }
      })
    } catch (error) {
      // A recheck denial is not an execution failure: nothing was written.
      if (!(error instanceof DestructiveAuthorizationDeniedError)) throw error
      denial = error
    }
    if (denial !== null) {
      deps.writeError(
        `bkagent: destructive authorization denied (${denial.reason}): ${denial.message}\n`,
      )
      return {
        result: authorizationDenied(plan, denial),
        lease: null,
        attemptId: null,
        persistence: null,
      }
    }
    if (acquired === null) {
      return { result: leaseDenied(plan), lease: null, attemptId: null, persistence: null }
    }
    lease = {
      targetId: acquired.held.targetId,
      owner: acquired.held.owner,
      token: acquired.held.token,
      expiresAt: acquired.held.expiresAt,
    }
    attemptId = acquired.attemptId

    // Fail closed: no subprocess may run when the run envelope was not recorded.
    if (!acquired.started.started) {
      return {
        result: startFailed(plan, acquired.started.reason),
        lease,
        attemptId,
        persistence: { persisted: false, reason: acquired.started.reason },
      }
    }
    const persistedAttemptId: AttemptId = attemptId

    const controller = new AbortController()
    let lost: string | null = null
    const heartbeat = startLeaseHeartbeat({
      repo,
      lease,
      ttlMs,
      intervalMs: heartbeatMs,
      now,
      onLost: (reason) => {
        lost = reason
        // A lost lease must stop the running command, not just future steps.
        controller.abort()
      },
    })

    const held: PlanLease = lease
    try {
      const result = await runPlan(plan, {
        executor: deps.executor,
        ...(deps.env === undefined ? {} : { env: deps.env }),
        systemIdentifier: instance.systemIdentifier,
        ...(deps.stateDir === undefined ? {} : { stateDir: deps.stateDir }),
        onStep: (event) => {
          if (event.type === 'start') deps.writeError(`[${event.stepId}] running\n`)
        },
        leaseGuard: () => lost === null && !controller.signal.aborted,
        signal: controller.signal,
      })

      // Terminal state, lineage and Outbox events commit in one short
      // transaction while the lease is still held. External work is already
      // finished, so no transaction spans a subprocess.
      const persistence = await finishRun(repo, {
        plan,
        result,
        lease: held,
        attemptId: persistedAttemptId,
        now: now(),
        ...(deps.artifact === undefined ? {} : { artifact: deps.artifact }),
      })
      // A successful or failed run whose terminal state could not be committed
      // authoritatively is reported as `lease-lost`: the caller must never treat
      // an unrecorded run as success.
      const finalResult =
        persistence.persisted || result.status === 'lease-lost'
          ? result
          : runNotAuthoritative(plan, result, persistence.reason)
      if (!persistence.persisted && result.status !== 'lease-lost') {
        deps.writeError(`bkagent: run outcome not recorded: ${persistence.reason}\n`)
      }
      if (deps.recordOutcome !== undefined) {
        await deps.recordOutcome(finalResult, held, persistedAttemptId)
      }
      return { result: finalResult, lease: held, attemptId: persistedAttemptId, persistence }
    } finally {
      // The heartbeat must be quiescent before the token is released.
      await heartbeat.stop()
    }
  } finally {
    if (lease !== null) {
      // Only the matching owner/token row is deleted; a superseded lease stays
      // untouched so the new holder keeps its authority.
      await repo.leases.release({
        targetId: lease.targetId,
        owner: lease.owner,
        token: lease.token,
      })
    }
    await repo.close()
  }
}

/**
 * Emits the canonical run summary and maps the result to the CLI exit code.
 */
export function reportPlanOutcome(
  plan: Plan,
  result: RunPlanResult,
  write: (text: string) => void,
): 0 | 1 {
  write(
    `${JSON.stringify(
      {
        planId: plan.planId,
        risk: plan.risk,
        steps: plan.steps.map((step) => step.stepId),
        result,
      },
      null,
      2,
    )}\n`,
  )
  return result.status === 'succeeded' ? 0 : 1
}
