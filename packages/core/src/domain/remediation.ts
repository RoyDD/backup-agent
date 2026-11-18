/**
 * Self-correction as a closed set.
 *
 * The core classifies a failed step and enumerates the remediations that are
 * admissible for it. The agent picks one of those and nothing else. Two
 * properties matter more than the taxonomy:
 *
 * 1. A failure caused by a missing approval never yields `replan`. Otherwise
 *    "the agent corrected itself" would be a way to route around four-eyes by
 *    choosing a different destructive action.
 * 2. `replan` needs a new action that passes the same capability grammar as
 *    the original. The agent may change its mind; it may not change the rules.
 */

import { isDestructiveAction, validateStepAction, type StepAction } from './action'
import type { ErrorClass } from './errors'
import { canTransitionGoal, canTransitionStep, type GoalState, type StepState } from './goal'
import type { GoalStepId } from './ids'

export const REMEDIATION_KINDS = ['retry', 'replan', 'escalate', 'abandon'] as const
export type RemediationKind = (typeof REMEDIATION_KINDS)[number]

export function isRemediationKind(value: unknown): value is RemediationKind {
  return typeof value === 'string' && (REMEDIATION_KINDS as readonly string[]).includes(value)
}

/** Failure signatures the goal layer decides on its own. */
export const APPROVAL_REQUIRED_SIGNATURE = 'approval:required'

export interface Remediation {
  readonly kind: RemediationKind
  readonly reason: string
  /** Only `replan` needs the caller to supply a replacement action. */
  readonly requiresAction: boolean
}

export interface Diagnosis {
  readonly stepId: GoalStepId
  readonly errorClass: ErrorClass
  readonly signature: string
  readonly exitCode: number | null
  readonly attempts: number
  readonly maxAttempts: number
  /** Closed set: the only remediations the agent may choose from. */
  readonly candidates: readonly Remediation[]
  /** True when every candidate needs a human decision. */
  readonly requiresHuman: boolean
}

export interface DiagnoseInput {
  readonly stepId: GoalStepId
  readonly errorClass: ErrorClass
  readonly signature: string
  readonly exitCode: number | null
  readonly attempts: number
  readonly maxAttempts: number
  /** Step attempts consumed across the whole goal. */
  readonly goalAttempts: number
  readonly maxGoalAttempts: number
  readonly action: StepAction
  /** Human principal recorded on the step, if any. */
  readonly approvedBy: string | null
}

const RETRY: Remediation = {
  kind: 'retry',
  reason: 'the failure class is transient and the attempt budget is not exhausted',
  requiresAction: false,
}
const REPLAN: Remediation = {
  kind: 'replan',
  reason: 'the plan is wrong, not the environment; supply a replacement action',
  requiresAction: true,
}
const ESCALATE: Remediation = {
  kind: 'escalate',
  reason: 'the decision belongs to a human; stop and report',
  requiresAction: false,
}
const ABANDON: Remediation = {
  kind: 'abandon',
  reason: 'stop pursuing this step',
  requiresAction: false,
}

/**
 * `approved` is false when the action is destructive and no human approved the
 * step. Such a failure is reported as an approval failure regardless of what
 * the command's stderr said, so a denied run can never be mistaken for a
 * transient error worth retrying.
 */
export function diagnose(input: DiagnoseInput): Diagnosis {
  const needsApproval =
    input.signature === APPROVAL_REQUIRED_SIGNATURE ||
    (isDestructiveAction(input.action) && input.approvedBy === null)

  if (needsApproval) {
    return {
      stepId: input.stepId,
      errorClass: 'manual',
      signature: APPROVAL_REQUIRED_SIGNATURE,
      exitCode: input.exitCode,
      attempts: input.attempts,
      maxAttempts: input.maxAttempts,
      candidates: [ESCALATE],
      requiresHuman: true,
    }
  }

  const budgetLeft = input.attempts < input.maxAttempts && input.goalAttempts < input.maxGoalAttempts

  if (input.errorClass === 'transient') {
    const candidates = budgetLeft ? [RETRY, ESCALATE] : [ESCALATE, ABANDON]
    return {
      stepId: input.stepId,
      errorClass: input.errorClass,
      signature: input.signature,
      exitCode: input.exitCode,
      attempts: input.attempts,
      maxAttempts: input.maxAttempts,
      candidates,
      requiresHuman: !budgetLeft,
    }
  }

  if (input.errorClass === 'permanent') {
    const candidates = budgetLeft ? [REPLAN, ESCALATE] : [ESCALATE, ABANDON]
    return {
      stepId: input.stepId,
      errorClass: input.errorClass,
      signature: input.signature,
      exitCode: input.exitCode,
      attempts: input.attempts,
      maxAttempts: input.maxAttempts,
      candidates,
      requiresHuman: !budgetLeft,
    }
  }

  return {
    stepId: input.stepId,
    errorClass: input.errorClass,
    signature: input.signature,
    exitCode: input.exitCode,
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
    candidates: [ESCALATE, ABANDON],
    requiresHuman: true,
  }
}

export type RemediationDecision =
  | {
      readonly ok: true
      readonly kind: RemediationKind
      readonly stepState: StepState
      readonly goalState: GoalState
      /** Present for `replan`: the action the caller supplied and the core accepted. */
      readonly action?: StepAction
    }
  | { readonly ok: false; readonly reason: string }

export interface DecideRemediationInput {
  readonly diagnosis: Diagnosis
  readonly kind: RemediationKind
  /** Current states, so the decision never proposes an illegal transition. */
  readonly stepState: StepState
  readonly goalState: GoalState
  /** Required for `replan`; validated with the same grammar as the original. */
  readonly action?: unknown
  /**
   * The goal's own destructive opt-in. A replan may not introduce a
   * destructive action into a goal that never allowed one: the replacement
   * would otherwise widen the goal's authority while looking like a fix.
   */
  readonly allowDestructive: boolean
}

const NEXT_STATES: Readonly<
  Record<RemediationKind, { readonly step: StepState; readonly goal: GoalState }>
> = {
  retry: { step: 'ready', goal: 'running' },
  replan: { step: 'ready', goal: 'planned' },
  escalate: { step: 'failed', goal: 'failed' },
  abandon: { step: 'abandoned', goal: 'abandoned' },
}

export function decideRemediation(input: DecideRemediationInput): RemediationDecision {
  const offered = input.diagnosis.candidates.some((candidate) => candidate.kind === input.kind)
  if (!offered) {
    const available = input.diagnosis.candidates.map((candidate) => candidate.kind).join(', ')
    return { ok: false, reason: `${input.kind} is not an available remediation (available: ${available})` }
  }

  const next = NEXT_STATES[input.kind]

  // A replan is a new plan, so it must pass the same grammar as the first one.
  if (input.kind === 'replan') {
    const issues = validateStepAction(input.action)
    if (issues.length > 0) {
      return {
        ok: false,
        reason: `replacement action rejected: ${issues.map((issue) => issue.message).join('; ')}`,
      }
    }
    if (isDestructiveAction(input.action as StepAction) && !input.allowDestructive) {
      return {
        ok: false,
        reason: 'replacement action rejected: the goal does not allow destructive steps',
      }
    }
  }

  if (input.stepState !== next.step && !canTransitionStep(input.stepState, next.step)) {
    return { ok: false, reason: `step cannot move from ${input.stepState} to ${next.step}` }
  }
  if (input.goalState !== next.goal && !canTransitionGoal(input.goalState, next.goal)) {
    return { ok: false, reason: `goal cannot move from ${input.goalState} to ${next.goal}` }
  }

  return {
    ok: true,
    kind: input.kind,
    stepState: next.step,
    goalState: next.goal,
    ...(input.kind === 'replan' ? { action: input.action as StepAction } : {}),
  }
}

/**
 * The one remediation the core may apply without asking anyone: a retry the
 * budget already authorises. It changes no plan and grants no authority, so it
 * is deterministic. Everything else either rewrites the plan (`replan`) or ends
 * the goal (`escalate`/`abandon`) and is decided above the core.
 */
export function autoRemediation(diagnosis: Diagnosis): Remediation | null {
  if (diagnosis.requiresHuman) return null
  return diagnosis.candidates.find((candidate) => candidate.kind === 'retry') ?? null
}
