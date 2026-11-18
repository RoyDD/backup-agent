/**
 * Goal decomposition validation and step scheduling.
 *
 * The invariant this module protects: the core never invents a step. It
 * validates the agent's decomposition and decides which step may run next.
 * Both functions are pure — no I/O, no clock, no environment — so the same
 * goal and the same step states always yield the same decision.
 *
 * Validation is fail-closed: a step whose action does not pass the action
 * grammar, whose dependency points outside the already-declared prefix, or
 * whose retry budget exceeds the goal's own limit is refused rather than
 * repaired.
 */

import {
  isDestructiveAction,
  validateStepAction,
  type StepAction,
} from '../domain/action'
import {
  isTerminalStepState,
  stepNeedsApproval,
  type GoalConstraints,
  type GoalState,
  type GoalStep,
} from '../domain/goal'
import type { GoalStepId } from '../domain/ids'

/** One step as the agent proposed it. `dependsOn` uses 1-based step numbers. */
export interface ProposedStep {
  readonly intent: string
  readonly action: unknown
  /** 1-based numbers of earlier steps this step depends on. */
  readonly dependsOn?: readonly number[]
  readonly maxAttempts?: number
}

export interface DecompositionIssue {
  /** 1-based index of the offending step, or 0 for a goal-level issue. */
  readonly step: number
  readonly field: 'steps' | 'intent' | 'action' | 'dependsOn' | 'maxAttempts'
  readonly message: string
}

/**
 * Validates a proposed decomposition against the goal's own limits.
 *
 * Dependencies may only name an *earlier* step. That restriction makes the
 * dependency graph acyclic by construction: every edge points backwards, so
 * no cycle can be written down, and the scheduler never needs cycle detection.
 */
export function validateDecomposition(
  constraints: GoalConstraints,
  steps: readonly ProposedStep[],
): DecompositionIssue[] {
  if (steps.length === 0) {
    return [{ step: 0, field: 'steps', message: 'a goal needs at least one step' }]
  }

  const issues: DecompositionIssue[] = []
  if (steps.length > constraints.maxSteps) {
    issues.push({
      step: 0,
      field: 'steps',
      message: `a goal may have at most ${constraints.maxSteps} steps, got ${steps.length}`,
    })
  }

  for (let index = 0; index < steps.length; index += 1) {
    const stepNumber = index + 1
    const step = steps[index] as ProposedStep
    // The agent's payload is untrusted at runtime; read it as unknown.
    const candidate = step as {
      readonly intent?: unknown
      readonly action?: unknown
      readonly dependsOn?: unknown
      readonly maxAttempts?: unknown
    }

    const intent = typeof candidate.intent === 'string' ? candidate.intent.trim() : ''
    if (intent === '') {
      issues.push({
        step: stepNumber,
        field: 'intent',
        message: 'intent must be a non-empty string',
      })
    }

    const actionIssues = validateStepAction(candidate.action)
    for (const issue of actionIssues) {
      issues.push({ step: stepNumber, field: 'action', message: issue.message })
    }
    if (actionIssues.length === 0) {
      // Safe only now: the grammar accepted the value, so it is a StepAction.
      const action = candidate.action as StepAction
      if (isDestructiveAction(action) && constraints.allowDestructive === false) {
        issues.push({
          step: stepNumber,
          field: 'action',
          message: 'the goal does not allow destructive steps',
        })
      }
    }

    if (candidate.dependsOn !== undefined) {
      if (!Array.isArray(candidate.dependsOn)) {
        issues.push({
          step: stepNumber,
          field: 'dependsOn',
          message: 'dependsOn must be an array of step numbers',
        })
      } else {
        for (const raw of candidate.dependsOn as unknown[]) {
          const dependency = raw as number
          if (typeof dependency !== 'number' || !Number.isInteger(dependency) || dependency < 1) {
            issues.push({
              step: stepNumber,
              field: 'dependsOn',
              message: `dependsOn entry ${JSON.stringify(raw)} must be a positive integer step number`,
            })
            continue
          }
          if (dependency === stepNumber) {
            issues.push({
              step: stepNumber,
              field: 'dependsOn',
              message: 'a step must not depend on itself',
            })
            continue
          }
          if (dependency > stepNumber) {
            issues.push({
              step: stepNumber,
              field: 'dependsOn',
              message: `a step may only depend on an earlier step; ${dependency} comes after ${stepNumber}`,
            })
          }
        }
      }
    }

    if (candidate.maxAttempts !== undefined) {
      const maxAttempts = candidate.maxAttempts as number
      if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
        issues.push({
          step: stepNumber,
          field: 'maxAttempts',
          message: 'maxAttempts must be a positive integer',
        })
      } else if (maxAttempts > constraints.maxStepAttempts) {
        issues.push({
          step: stepNumber,
          field: 'maxAttempts',
          message: `maxAttempts must be at most ${constraints.maxStepAttempts}`,
        })
      }
    }
  }

  return issues
}

export interface GoalProgress {
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly abandoned: number
  readonly ready: number
  readonly pending: number
  readonly blocked: number
}

/**
 * Counts steps per state. `running` steps appear only in `total`: they are
 * neither finished nor available, so they belong to no progress bucket.
 */
export function goalProgress(steps: readonly GoalStep[]): GoalProgress {
  const counts: Record<string, number> = {}
  for (const step of steps) {
    counts[step.state] = (counts[step.state] ?? 0) + 1
  }
  return {
    total: steps.length,
    succeeded: counts['succeeded'] ?? 0,
    failed: counts['failed'] ?? 0,
    abandoned: counts['abandoned'] ?? 0,
    ready: counts['ready'] ?? 0,
    pending: counts['pending'] ?? 0,
    blocked: counts['blocked'] ?? 0,
  }
}

export type SchedulerOutcome =
  /** A step may be dispatched now. */
  | { readonly kind: 'run'; readonly step: GoalStep }
  /** Every step is settled: terminal, or blocked because a dependency can never succeed. */
  | { readonly kind: 'done'; readonly failed: boolean }
  /** These pending steps can never run: a dependency failed, was abandoned, was blocked, or is missing. */
  | { readonly kind: 'blocked'; readonly stepIds: readonly GoalStepId[] }
  /** Nothing is runnable yet, but nothing is blocked either. */
  | { readonly kind: 'waiting' }
  /** The goal has no steps. */
  | { readonly kind: 'empty' }

function byOrdinal(steps: readonly GoalStep[]): GoalStep[] {
  return [...steps].sort((left, right) => left.ordinal - right.ordinal)
}

function indexById(steps: readonly GoalStep[]): Map<GoalStepId, GoalStep> {
  const byId = new Map<GoalStepId, GoalStep>()
  for (const step of steps) byId.set(step.stepId, step)
  return byId
}

/**
 * Decides the next scheduler action. Order matters: an already `ready` step
 * wins over a pending one, a runnable pending step wins over reporting
 * blocked steps, and only a goal with nothing left to run is reported done.
 *
 * A dependency id that no step declares counts as unsatisfied, so the step is
 * blocked rather than silently dispatched (fail closed).
 */
export function nextRunnable(steps: readonly GoalStep[]): SchedulerOutcome {
  if (steps.length === 0) return { kind: 'empty' }

  const ordered = byOrdinal(steps)
  const byId = indexById(ordered)

  const ready = ordered.find((step) => step.state === 'ready')
  if (ready !== undefined) return { kind: 'run', step: ready }

  const pending = ordered.filter((step) => step.state === 'pending')
  const runnable = pending.find((step) =>
    step.dependsOn.every((dependencyId) => byId.get(dependencyId)?.state === 'succeeded'),
  )
  if (runnable !== undefined) return { kind: 'run', step: runnable }

  const blocked = blockedStepIds(ordered)
  if (blocked.length > 0) return { kind: 'blocked', stepIds: blocked }

  // `blocked` counts as settled here: a blocked step can never run, so a goal
  // that only has blocked steps left must be able to finish instead of waiting
  // forever. `running` keeps the goal open, so it falls through to `waiting`.
  const settled = ordered.every(
    (step) => isTerminalStepState(step.state) || step.state === 'blocked',
  )
  if (settled) {
    return {
      kind: 'done',
      failed: ordered.some(
        (step) =>
          step.state === 'failed' || step.state === 'abandoned' || step.state === 'blocked',
      ),
    }
  }

  return { kind: 'waiting' }
}

/**
 * Steps that must be marked `blocked` given the current states, in ordinal
 * order. Only `pending` steps are reported: the step state machine does not
 * allow `ready` to move to `blocked`, and terminal steps are already decided.
 *
 * `blocked` propagates. A dependency that already failed, was abandoned, was
 * itself blocked, or does not exist can never succeed, so its dependents are
 * blocked too — otherwise a chain A → B → C would leave C `pending` forever
 * once B is blocked, and the goal could never reach `done`.
 */
export function blockedStepIds(steps: readonly GoalStep[]): readonly GoalStepId[] {
  const ordered = byOrdinal(steps)
  const byId = indexById(ordered)
  const blocked: GoalStepId[] = []

  for (const step of ordered) {
    if (step.state !== 'pending') continue
    const stuck = step.dependsOn.some((dependencyId) => {
      const dependency = byId.get(dependencyId)
      if (dependency === undefined) return true
      return (
        dependency.state === 'failed' ||
        dependency.state === 'abandoned' ||
        dependency.state === 'blocked'
      )
    })
    if (stuck) blocked.push(step.stepId)
  }

  return blocked
}

/**
 * The agent's next decision, as the loop's contract states it.
 *
 * `next` (a `SchedulerOutcome`) answers one question: may the core dispatch a
 * step now. It says nothing about whether the agent should keep going, ask a
 * human, or choose a remediation. `hint` is that second answer. It is derived
 * from persisted state alone, so two identical control databases always
 * produce the same value and a replay can assert it.
 *
 * Precedence, highest first:
 *
 * 1. `done` - the goal is terminal. `failed` and `abandoned` count as terminal:
 *    an escalated failure is a human's decision, and re-diagnosing it would
 *    turn `escalate` into a suggestion.
 * 2. `remediate` - a step is `failed` and its candidate set is still open. This
 *    outranks `run_step`: an unrelated runnable step does not answer that
 *    decision, and dependents of the failed step cannot run until it is
 *    settled.
 * 3. `await_approval` - the next runnable step is destructive and unapproved.
 *    Only a human can unlock it.
 * 4. `run_step` - the scheduler may dispatch.
 * 5. `done` - nothing runnable and nothing failed: blocked or empty only.
 */
export const AGENT_HINTS = ['run_step', 'remediate', 'await_approval', 'done'] as const
export type AgentHint = (typeof AGENT_HINTS)[number]

export function agentHint(goalState: GoalState, steps: readonly GoalStep[]): AgentHint {
  if (goalState === 'succeeded' || goalState === 'failed' || goalState === 'abandoned') {
    return 'done'
  }
  if (steps.some((step) => step.state === 'failed')) return 'remediate'
  const outcome = nextRunnable(steps)
  if (outcome.kind === 'run') {
    return stepNeedsApproval(outcome.step.action, outcome.step.approvedBy)
      ? 'await_approval'
      : 'run_step'
  }
  return 'done'
}
