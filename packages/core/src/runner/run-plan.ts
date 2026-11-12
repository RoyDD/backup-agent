import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ErrorClass } from '../domain/errors'
import type { Plan, Step } from '../domain/plan'
import type { Executor } from '../ports/executor'
import { classifyRunResult } from '../executor/classify'
import { evaluateAll, type CustomPredicate, type PredicateContext } from './predicate'

export interface StepOutcome {
  stepId: string
  /**
   * `lease-lost` marks a step the runner refused to continue because it could
   * no longer prove it still holds execution authority. It is not a command
   * failure and carries no `errorClass`.
   */
  status: 'succeeded' | 'failed' | 'skipped' | 'lease-lost'
  attempts: number
  exitCode: number | null
  errorClass?: ErrorClass
  message?: string
  stdout: string
  stderr: string
  durationMs: number
}

/** Where the lease was found lost relative to command dispatch. */
export type LeaseLostPhase = 'before-step' | 'before-retry' | 'after-step'

export interface LeaseLost {
  /** Step being dispatched, or the step whose command just returned. */
  stepId?: string
  phase: LeaseLostPhase
  message: string
}

export interface RunPlanResult {
  planId: string
  /**
   * `lease-lost` is an explicit non-success outcome: the runner stopped because
   * execution authority could not be confirmed, not because a command failed.
   */
  status: 'succeeded' | 'failed' | 'lease-lost'
  steps: StepOutcome[]
  failedStep?: string
  errorClass?: ErrorClass
  error?: string
  /** Present only when `status` is `lease-lost`. */
  leaseLost?: LeaseLost
  /**
   * Outcomes of the Plan's cleanup graph, present only when it ran (that is, the
   * main graph failed). Cleanup failures never replace `failedStep`/`error`.
   */
  cleanup?: readonly StepOutcome[]
  /** Cleanup step ids that failed; the target may need manual attention. */
  cleanupFailed?: readonly string[]
}

/**
 * Async lease probe supplied by the caller. Returning `false` (or throwing)
 * means the runner must stop dispatching work; the caller owns heartbeats and
 * must abort `RunPlanOptions.signal` to kill an in-flight command.
 */
export type LeaseGuard = () => boolean | Promise<boolean>

export interface StepEvent {
  type: 'start' | 'finish'
  stepId: string
  outcome?: StepOutcome
}

export interface RunPlanOptions {
  executor: Executor
  cwd?: string
  env?: Readonly<Record<string, string>>
  stateDir?: string
  resume?: boolean
  systemIdentifier?: string | null
  customPredicates?: Readonly<Record<string, CustomPredicate>>
  sleep?: (ms: number) => Promise<void>
  onStep?: (event: StepEvent) => void
  now?: () => string
  /** Checked before each step and after each executor call. */
  leaseGuard?: LeaseGuard
  /** Forwarded to `Executor.run` so a lost lease can abort a running command. */
  signal?: AbortSignal
}

interface CheckpointState {
  planId: string
  completed: string[]
  updatedAt: string
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Kahn topological sort; the Plan validator already guarantees acyclicity. */
export function topologicalOrder(steps: readonly Step[]): Step[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]))
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const step of steps) {
    indegree.set(step.stepId, step.dependsOn.length)
    for (const dependency of step.dependsOn) {
      const list = dependents.get(dependency) ?? []
      list.push(step.stepId)
      dependents.set(dependency, list)
    }
  }

  const queue = steps.filter((step) => (indegree.get(step.stepId) ?? 0) === 0)
  const ordered: Step[] = []
  while (queue.length > 0) {
    const step = queue.shift()
    if (!step) break
    ordered.push(step)
    for (const nextId of dependents.get(step.stepId) ?? []) {
      const remaining = (indegree.get(nextId) ?? 0) - 1
      indegree.set(nextId, remaining)
      if (remaining === 0) {
        const next = byId.get(nextId)
        if (next) queue.push(next)
      }
    }
  }
  return ordered
}

function backoffDelay(policy: Step['retry'], attempt: number): number {
  if (policy.backoff === 'none') return 0
  const base =
    policy.backoff === 'linear'
      ? policy.initialDelayMs * attempt
      : policy.initialDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(policy.maxDelayMs, base)
}

function statePath(stateDir: string, planId: string): string {
  return join(stateDir, `${planId}.json`)
}

/**
 * Applies a step's checkpoint policy to the resume set and reports whether the
 * checkpoint file should be written.
 *
 * - `after` (default): the step finished, so its side effects are done and a
 *   resume may skip it.
 * - `none`: nothing is recorded; the step always re-runs on resume.
 * - `before`: the boundary *before* the step is recorded, but the step is never
 *   marked finished, so a resume returns to that boundary and re-runs it. This
 *   is the safe mode for a step whose side effects are not idempotent.
 */
function checkpointStep(step: Step, completed: Set<string>): boolean {
  if (step.checkpoint === 'after') {
    completed.add(step.stepId)
    return true
  }
  return step.checkpoint === 'before'
}

function loadCompleted(stateDir: string | undefined, planId: string): Set<string> {
  if (!stateDir) return new Set()
  try {
    const raw = readFileSync(statePath(stateDir, planId), 'utf8')
    const parsed = JSON.parse(raw) as CheckpointState
    return new Set(parsed.completed)
  } catch {
    return new Set()
  }
}

function saveCompleted(
  stateDir: string | undefined,
  planId: string,
  completed: Set<string>,
  now: string,
): void {
  if (!stateDir) return
  mkdirSync(stateDir, { recursive: true })
  const target = statePath(stateDir, planId)
  const temporary = `${target}.tmp`
  const body: CheckpointState = { planId, completed: [...completed], updatedAt: now }
  writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  renameSync(temporary, target)
}

function failure(
  step: Step,
  errorClass: ErrorClass,
  message: string,
  stdout = '',
  stderr = '',
  exitCode: number | null = null,
  attempts = 1,
  durationMs = 0,
): StepOutcome {
  return {
    stepId: step.stepId,
    status: 'failed',
    attempts,
    exitCode,
    errorClass,
    message,
    stdout,
    stderr,
    durationMs,
  }
}

interface LeaseCheck {
  held: boolean
  message: string
}

/** Fail-closed probe: a throwing guard is treated as a lost lease. */
async function checkLease(guard: LeaseGuard | undefined): Promise<LeaseCheck> {
  if (!guard) return { held: true, message: '' }
  try {
    const held = await guard()
    return { held, message: held ? '' : 'lease guard reported the lease as lost' }
  } catch (error) {
    return { held: false, message: `lease guard failed: ${(error as Error).message}` }
  }
}

function leaseLostStep(
  step: Step,
  message: string,
  attempts: number,
  exitCode: number | null = null,
  stdout = '',
  stderr = '',
  durationMs = 0,
): StepOutcome {
  return {
    stepId: step.stepId,
    status: 'lease-lost',
    attempts,
    exitCode,
    message,
    stdout,
    stderr,
    durationMs,
  }
}

function leaseLostResult(
  plan: Plan,
  outcomes: StepOutcome[],
  leaseLost: LeaseLost,
): RunPlanResult {
  return {
    planId: plan.planId,
    status: 'lease-lost',
    steps: outcomes,
    error: leaseLost.message,
    leaseLost,
  }
}

interface CleanupRun {
  readonly outcomes: readonly StepOutcome[]
}

/**
 * Runs the Plan's cleanup graph after the main graph failed.
 *
 * Best-effort by design: every cleanup step is attempted even when an earlier one
 * failed, a step whose preconditions no longer hold is skipped (so a repeated
 * attempt is idempotent), and no checkpoint is written. A lease lost before a
 * cleanup step stops the cleanup immediately: without authority nothing may be
 * dispatched. Cleanup failures are reported, never allowed to mask the original
 * failure that triggered them.
 */
async function runCleanupSteps(
  plan: Plan,
  options: RunPlanOptions,
  predicateContext: PredicateContext,
  sleep: (ms: number) => Promise<void>,
): Promise<CleanupRun> {
  const steps = plan.cleanup
  if (steps === undefined || steps.length === 0) return { outcomes: [] }

  const outcomes: StepOutcome[] = []

  for (const step of topologicalOrder(steps)) {
    const before = await checkLease(options.leaseGuard)
    if (!before.held) {
      outcomes.push(leaseLostStep(step, before.message, 0))
      break
    }

    options.onStep?.({ type: 'start', stepId: step.stepId })
    const preconditionsHold = await evaluateAll(step.preconditions, predicateContext)
    if (!preconditionsHold) {
      const skipped: StepOutcome = {
        stepId: step.stepId,
        status: 'skipped',
        attempts: 0,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
      }
      outcomes.push(skipped)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome: skipped })
      continue
    }

    if (step.kind === 'write-file') {
      let outcome: StepOutcome
      try {
        if (!step.file) throw new Error('step has no file payload')
        mkdirSync(dirname(step.file.path), { recursive: true })
        writeFileSync(step.file.path, step.file.content, 'utf8')
        if (step.file.mode !== undefined) chmodSync(step.file.path, step.file.mode)
        const postconditionsHold = await evaluateAll(step.postconditions, predicateContext)
        outcome = postconditionsHold
          ? {
              stepId: step.stepId,
              status: 'succeeded',
              attempts: 1,
              exitCode: 0,
              stdout: '',
              stderr: '',
              durationMs: 0,
            }
          : failure(step, 'permanent', 'postcondition failed')
      } catch (error) {
        outcome = failure(step, 'permanent', (error as Error).message)
      }
      outcomes.push(outcome)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })
      continue
    }

    if (step.argv === undefined) {
      const outcome = failure(step, 'permanent', 'step has no argv')
      outcomes.push(outcome)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })
      continue
    }

    let outcome: StepOutcome | undefined
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
      const result = await options.executor.run(step.argv, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: step.timeoutMs,
        signal: options.signal,
      })

      if (result.exitCode === 0 && !result.timedOut) {
        const postconditionsHold = await evaluateAll(step.postconditions, predicateContext)
        outcome = postconditionsHold
          ? {
              stepId: step.stepId,
              status: 'succeeded',
              attempts: attempt,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              durationMs: result.durationMs,
            }
          : failure(
              step,
              'permanent',
              'postcondition failed',
              result.stdout,
              result.stderr,
              result.exitCode,
              attempt,
              result.durationMs,
            )
        break
      }

      const errorClass = classifyRunResult(result)
      const aborted = options.signal?.aborted === true
      const retryable = !aborted && step.retry.retryOn.includes(errorClass)
      if (!retryable || attempt === step.retry.maxAttempts) {
        outcome = failure(
          step,
          errorClass,
          errorClass === 'transient' ? 'retry budget exhausted' : 'cleanup step failed',
          result.stdout,
          result.stderr,
          result.exitCode,
          attempt,
          result.durationMs,
        )
        break
      }
      await sleep(backoffDelay(step.retry, attempt))
    }

    if (!outcome) {
      outcome = failure(step, 'permanent', 'retry loop produced no outcome')
    }
    outcomes.push(outcome)
    options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })

    // A lease lost during cleanup ends the cleanup; the terminal write is
    // refused later by the fence and live-lease guards.
    const after = await checkLease(options.leaseGuard)
    if (!after.held) break
  }

  return { outcomes }
}

/**
 * Executes a validated Plan step by step. Preconditions are re-evaluated at
 * execution time; transient failures are retried with the step's policy and
 * successful steps are checkpointed when a state directory is configured.
 *
 * Lease loss is terminal and is reported as `lease-lost`, never as an ordinary
 * failed attempt: the runner has no authority to retry, checkpoint, or keep
 * dispatching once `leaseGuard` rejects. The guard is re-checked at every point
 * where async work could outlive the lease — before a step, after precondition
 * evaluation, after each executor call, after postcondition evaluation (also for
 * write-file steps), and after retry backoff before re-dispatch. A lost lease
 * must abort `signal` so an in-flight command is killed.
 */
export async function runPlan(plan: Plan, options: RunPlanOptions): Promise<RunPlanResult> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => new Date().toISOString())
  const completed = options.resume ? loadCompleted(options.stateDir, plan.planId) : new Set<string>()
  const outcomes: StepOutcome[] = []
  const predicateContext = {
    executor: options.executor,
    cwd: options.cwd,
    env: options.env,
    systemIdentifier: options.systemIdentifier,
    custom: options.customPredicates,
  }

  if (!options.resume) saveCompleted(options.stateDir, plan.planId, completed, now())

  /**
   * Terminal failure: the cleanup graph runs before the result is returned, so a
   * caller never has to remember compensation. Cleanup failures are reported
   * alongside the original failure instead of replacing it.
   */
  const fail = async (fields: {
    failedStep: string
    errorClass: ErrorClass
    error?: string
  }): Promise<RunPlanResult> => {
    const cleanup = await runCleanupSteps(plan, options, predicateContext, sleep)
    const cleanupFailed = cleanup.outcomes
      .filter((outcome) => outcome.status === 'failed')
      .map((outcome) => outcome.stepId)
    return {
      planId: plan.planId,
      status: 'failed',
      steps: outcomes,
      ...fields,
      ...(cleanup.outcomes.length === 0 ? {} : { cleanup: cleanup.outcomes }),
      ...(cleanupFailed.length === 0 ? {} : { cleanupFailed }),
    }
  }

  for (const step of topologicalOrder(plan.steps)) {
    if (completed.has(step.stepId)) {
      const skipped: StepOutcome = {
        stepId: step.stepId,
        status: 'skipped',
        attempts: 0,
        exitCode: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
      }
      outcomes.push(skipped)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome: skipped })
      continue
    }

    const beforeStep = await checkLease(options.leaseGuard)
    if (!beforeStep.held) {
      return leaseLostResult(plan, outcomes, {
        stepId: step.stepId,
        phase: 'before-step',
        message: beforeStep.message,
      })
    }

    options.onStep?.({ type: 'start', stepId: step.stepId })
    const preconditionsHold = await evaluateAll(step.preconditions, predicateContext)

    // Precondition evaluation may be slow (command probes, remote checks); the
    // lease could have expired while it ran. Nothing has been dispatched yet.
    const afterPreconditions = await checkLease(options.leaseGuard)
    if (!afterPreconditions.held) {
      const lost = leaseLostStep(step, afterPreconditions.message, 0)
      outcomes.push(lost)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome: lost })
      return leaseLostResult(plan, outcomes, {
        stepId: step.stepId,
        phase: 'before-step',
        message: afterPreconditions.message,
      })
    }

    if (!preconditionsHold) {
      const outcome = failure(step, 'permanent', 'precondition failed')
      outcomes.push(outcome)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })
      return await fail({
        failedStep: step.stepId,
        errorClass: 'permanent',
        error: 'precondition failed',
      })
    }

    if (step.kind === 'write-file') {
      let outcome: StepOutcome
      try {
        if (!step.file) throw new Error('step has no file payload')
        mkdirSync(dirname(step.file.path), { recursive: true })
        writeFileSync(step.file.path, step.file.content, 'utf8')
        if (step.file.mode !== undefined) chmodSync(step.file.path, step.file.mode)
        const postconditionsHold = await evaluateAll(step.postconditions, predicateContext)
        // The file is already on disk; without a lease the step must not be
        // checkpointed as completed, so surface the loss instead of success.
        const afterWrite = await checkLease(options.leaseGuard)
        if (!afterWrite.held) {
          const lost = leaseLostStep(step, afterWrite.message, 1, 0)
          outcomes.push(lost)
          options.onStep?.({ type: 'finish', stepId: step.stepId, outcome: lost })
          return leaseLostResult(plan, outcomes, {
            stepId: step.stepId,
            phase: 'after-step',
            message: afterWrite.message,
          })
        }
        outcome = postconditionsHold
          ? {
              stepId: step.stepId,
              status: 'succeeded',
              attempts: 1,
              exitCode: 0,
              stdout: '',
              stderr: '',
              durationMs: 0,
            }
          : failure(step, 'permanent', 'postcondition failed')
      } catch (error) {
        outcome = failure(step, 'permanent', (error as Error).message)
      }
      outcomes.push(outcome)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })
      if (outcome.status !== 'succeeded') {
        return await fail({
          failedStep: step.stepId,
          errorClass: outcome.errorClass ?? 'permanent',
          ...(outcome.message === undefined ? {} : { error: outcome.message }),
        })
      }
      if (checkpointStep(step, completed)) {
        saveCompleted(options.stateDir, plan.planId, completed, now())
      }
      continue
    }

    if (step.argv === undefined) {
      const outcome = failure(step, 'permanent', 'step has no argv')
      outcomes.push(outcome)
      return await fail({
        failedStep: step.stepId,
        errorClass: 'permanent',
        error: 'step has no argv',
      })
    }

    let outcome: StepOutcome | undefined
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
      const result = await options.executor.run(step.argv, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: step.timeoutMs,
        signal: options.signal,
      })

      // Re-check after the call: a lease lost mid-command must not be retried,
      // classified, or checkpointed, even when the command itself succeeded.
      const afterStep = await checkLease(options.leaseGuard)
      if (!afterStep.held) {
        const lost = leaseLostStep(
          step,
          afterStep.message,
          attempt,
          result.exitCode,
          result.stdout,
          result.stderr,
          result.durationMs,
        )
        outcomes.push(lost)
        options.onStep?.({ type: 'finish', stepId: step.stepId, outcome: lost })
        return leaseLostResult(plan, outcomes, {
          stepId: step.stepId,
          phase: 'after-step',
          message: afterStep.message,
        })
      }

      if (result.exitCode === 0 && !result.timedOut) {
        const postconditionsHold = await evaluateAll(step.postconditions, predicateContext)

        // Postconditions may themselves run commands. Success is only terminal
        // once the lease still holds; otherwise the step must not be checkpointed.
        const afterPostconditions = await checkLease(options.leaseGuard)
        if (!afterPostconditions.held) {
          const lost = leaseLostStep(
            step,
            afterPostconditions.message,
            attempt,
            result.exitCode,
            result.stdout,
            result.stderr,
            result.durationMs,
          )
          outcomes.push(lost)
          options.onStep?.({ type: 'finish', stepId: step.stepId, outcome: lost })
          return leaseLostResult(plan, outcomes, {
            stepId: step.stepId,
            phase: 'after-step',
            message: afterPostconditions.message,
          })
        }

        if (postconditionsHold) {
          outcome = {
            stepId: step.stepId,
            status: 'succeeded',
            attempts: attempt,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
          }
        } else {
          outcome = failure(
            step,
            'permanent',
            'postcondition failed',
            result.stdout,
            result.stderr,
            result.exitCode,
            attempt,
            result.durationMs,
          )
        }
        break
      }

      const errorClass = classifyRunResult(result)
      // An aborted run means the caller revoked execution (e.g. lease lost);
      // retrying would re-dispatch work nobody is authorised to run.
      const aborted = options.signal?.aborted === true
      const retryable = !aborted && step.retry.retryOn.includes(errorClass)
      if (!retryable || attempt === step.retry.maxAttempts) {
        outcome = failure(
          step,
          errorClass,
          errorClass === 'transient' ? 'retry budget exhausted' : 'step failed',
          result.stdout,
          result.stderr,
          result.exitCode,
          attempt,
          result.durationMs,
        )
        break
      }
      await sleep(backoffDelay(step.retry, attempt))

      // Backoff can outlast the lease; re-verify before re-dispatching.
      const beforeRetry = await checkLease(options.leaseGuard)
      if (!beforeRetry.held) {
        const lost = leaseLostStep(
          step,
          beforeRetry.message,
          attempt,
          result.exitCode,
          result.stdout,
          result.stderr,
          result.durationMs,
        )
        outcomes.push(lost)
        options.onStep?.({ type: 'finish', stepId: step.stepId, outcome: lost })
        return leaseLostResult(plan, outcomes, {
          stepId: step.stepId,
          phase: 'before-retry',
          message: beforeRetry.message,
        })
      }
    }

    if (!outcome) {
      outcome = failure(step, 'permanent', 'retry loop produced no outcome')
    }
    outcomes.push(outcome)
    options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })

    if (outcome.status !== 'succeeded') {
      return await fail({
        failedStep: step.stepId,
        errorClass: outcome.errorClass ?? 'permanent',
        ...(outcome.message === undefined ? {} : { error: outcome.message }),
      })
    }

    if (checkpointStep(step, completed)) {
      saveCompleted(options.stateDir, plan.planId, completed, now())
    }
  }

  return { planId: plan.planId, status: 'succeeded', steps: outcomes }
}
