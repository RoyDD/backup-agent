import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ErrorClass } from '../domain/errors'
import type { Plan, Step } from '../domain/plan'
import type { Executor } from '../ports/executor'
import { classifyRunResult } from '../executor/classify'
import { evaluateAll, type CustomPredicate } from './predicate'

export interface StepOutcome {
  stepId: string
  status: 'succeeded' | 'failed' | 'skipped'
  attempts: number
  exitCode: number | null
  errorClass?: ErrorClass
  message?: string
  stdout: string
  stderr: string
  durationMs: number
}

export interface RunPlanResult {
  planId: string
  status: 'succeeded' | 'failed'
  steps: StepOutcome[]
  failedStep?: string
  errorClass?: ErrorClass
  error?: string
}

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

/**
 * Executes a validated Plan step by step. Preconditions are re-evaluated at
 * execution time; transient failures are retried with the step's policy and
 * successful steps are checkpointed when a state directory is configured.
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

    options.onStep?.({ type: 'start', stepId: step.stepId })

    const preconditionsHold = await evaluateAll(step.preconditions, predicateContext)
    if (!preconditionsHold) {
      const outcome = failure(step, 'permanent', 'precondition failed')
      outcomes.push(outcome)
      options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })
      return {
        planId: plan.planId,
        status: 'failed',
        steps: outcomes,
        failedStep: step.stepId,
        errorClass: 'permanent',
        error: 'precondition failed',
      }
    }

    if (step.argv === undefined) {
      const outcome = failure(step, 'permanent', 'step has no argv')
      outcomes.push(outcome)
      return {
        planId: plan.planId,
        status: 'failed',
        steps: outcomes,
        failedStep: step.stepId,
        errorClass: 'permanent',
        error: 'step has no argv',
      }
    }

    let outcome: StepOutcome | undefined
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
      const result = await options.executor.run(step.argv, {
        cwd: options.cwd,
        env: options.env,
        timeoutMs: step.timeoutMs,
      })

      if (result.exitCode === 0 && !result.timedOut) {
        const postconditionsHold = await evaluateAll(step.postconditions, predicateContext)
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
      const retryable = step.retry.retryOn.includes(errorClass)
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
    }

    if (!outcome) {
      outcome = failure(step, 'permanent', 'retry loop produced no outcome')
    }
    outcomes.push(outcome)
    options.onStep?.({ type: 'finish', stepId: step.stepId, outcome })

    if (outcome.status !== 'succeeded') {
      return {
        planId: plan.planId,
        status: 'failed',
        steps: outcomes,
        failedStep: step.stepId,
        errorClass: outcome.errorClass ?? 'permanent',
        error: outcome.message,
      }
    }

    completed.add(step.stepId)
    saveCompleted(options.stateDir, plan.planId, completed, now())
  }

  return { planId: plan.planId, status: 'succeeded', steps: outcomes }
}
