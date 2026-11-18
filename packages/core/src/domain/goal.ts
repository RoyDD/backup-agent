/**
 * A Goal is the agent's durable intent plus its own decomposition of that
 * intent. It is the layer the strict definition of an agent requires: a
 * stated objective, an ordered set of steps the agent chose, and a state
 * machine the deterministic core enforces.
 *
 * The core never invents steps and never relaxes a limit to make a goal
 * succeed. It validates the decomposition, decides which step may run next,
 * and records every transition.
 */

import type { ErrorClass } from './errors'
import type { GoalId, GoalStepId, PlanId, TargetId } from './ids'
import { isDestructiveAction, type StepAction } from './action'

export const GOAL_STATES = [
  'open',
  'planned',
  'running',
  'succeeded',
  'failed',
  'abandoned',
] as const
export type GoalState = (typeof GOAL_STATES)[number]

export const STEP_STATES = [
  'pending',
  'ready',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'abandoned',
] as const
export type StepState = (typeof STEP_STATES)[number]

/**
 * `planned` is reachable again from `running`/`failed`: a replan revises the
 * decomposition without pretending the earlier attempts did not happen.
 */
const GOAL_TRANSITIONS: Record<GoalState, readonly GoalState[]> = {
  open: ['planned', 'abandoned'],
  planned: ['running', 'planned', 'abandoned'],
  running: ['succeeded', 'failed', 'planned', 'abandoned'],
  succeeded: [],
  failed: ['planned', 'abandoned'],
  abandoned: [],
}

const STEP_TRANSITIONS: Record<StepState, readonly StepState[]> = {
  pending: ['ready', 'blocked', 'abandoned'],
  ready: ['running', 'pending', 'abandoned'],
  running: ['succeeded', 'failed', 'ready', 'abandoned'],
  succeeded: [],
  failed: ['ready', 'abandoned'],
  blocked: ['ready', 'abandoned'],
  abandoned: [],
}

export function canTransitionGoal(from: GoalState, to: GoalState): boolean {
  return GOAL_TRANSITIONS[from].includes(to)
}

export function canTransitionStep(from: StepState, to: StepState): boolean {
  return STEP_TRANSITIONS[from].includes(to)
}

export function isTerminalGoalState(state: GoalState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'abandoned'
}

export function isTerminalStepState(state: StepState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'abandoned'
}

/**
 * Limits are part of the goal, not of the caller's mood: they are stored with
 * the goal and re-read on every step, so a retry loop cannot outlive them.
 */
export interface GoalConstraints {
  readonly maxSteps: number
  readonly maxStepAttempts: number
  readonly maxGoalAttempts: number
  /**
   * A goal must opt in before any destructive step can be considered. Even
   * then each destructive step needs its own human approval.
   */
  readonly allowDestructive: boolean
}

export const DEFAULT_GOAL_CONSTRAINTS: GoalConstraints = {
  maxSteps: 20,
  maxStepAttempts: 3,
  maxGoalAttempts: 9,
  allowDestructive: false,
}

export const GOAL_LIMITS = {
  maxSteps: 100,
  maxStepAttempts: 10,
  maxGoalAttempts: 100,
} as const

export interface GoalConstraintsIssue {
  readonly field: keyof GoalConstraints
  readonly message: string
}

export function validateGoalConstraints(value: unknown): GoalConstraintsIssue[] {
  const issues: GoalConstraintsIssue[] = []
  if (typeof value !== 'object' || value === null) {
    return [{ field: 'maxSteps', message: 'constraints must be an object' }]
  }
  const candidate = value as Record<string, unknown>

  const bounded = (field: 'maxSteps' | 'maxStepAttempts' | 'maxGoalAttempts'): void => {
    const raw = candidate[field]
    if (raw === undefined) return
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
      issues.push({ field, message: 'must be a positive integer' })
      return
    }
    if (raw > GOAL_LIMITS[field]) {
      issues.push({ field, message: `must be at most ${GOAL_LIMITS[field]}` })
    }
  }
  bounded('maxSteps')
  bounded('maxStepAttempts')
  bounded('maxGoalAttempts')

  if (candidate['allowDestructive'] !== undefined && typeof candidate['allowDestructive'] !== 'boolean') {
    issues.push({ field: 'allowDestructive', message: 'must be a boolean' })
  }

  return issues
}

export function resolveGoalConstraints(partial: unknown): GoalConstraints {
  if (partial === undefined || partial === null) return DEFAULT_GOAL_CONSTRAINTS
  const candidate = partial as Partial<GoalConstraints>
  return {
    maxSteps: candidate.maxSteps ?? DEFAULT_GOAL_CONSTRAINTS.maxSteps,
    maxStepAttempts: candidate.maxStepAttempts ?? DEFAULT_GOAL_CONSTRAINTS.maxStepAttempts,
    maxGoalAttempts: candidate.maxGoalAttempts ?? DEFAULT_GOAL_CONSTRAINTS.maxGoalAttempts,
    allowDestructive: candidate.allowDestructive ?? DEFAULT_GOAL_CONSTRAINTS.allowDestructive,
  }
}

export interface Goal {
  readonly goalId: GoalId
  readonly principalId: string
  readonly targetId: TargetId
  /** What the operator asked for, verbatim. Never rewritten by the core. */
  readonly intent: string
  readonly state: GoalState
  readonly constraints: GoalConstraints
  readonly createdAt: string
  readonly updatedAt: string
}

export interface GoalStep {
  readonly stepId: GoalStepId
  readonly goalId: GoalId
  readonly ordinal: number
  /** Why this step exists, in the agent's words. */
  readonly intent: string
  readonly action: StepAction
  readonly dependsOn: readonly GoalStepId[]
  readonly state: StepState
  readonly attempts: number
  readonly maxAttempts: number
  readonly planId: PlanId | null
  /** Human principal who authorised this step's destructive action. */
  readonly approvedBy: string | null
  readonly approvedAt: string | null
  readonly lastErrorClass: ErrorClass | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** A step needs approval when its action is destructive and no human approved it. */
export function stepNeedsApproval(action: StepAction, approvedBy: string | null): boolean {
  return isDestructiveAction(action) && approvedBy === null
}
