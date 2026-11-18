import { describe, expect, it } from 'vitest'

import {
  DEFAULT_GOAL_CONSTRAINTS,
  GOAL_LIMITS,
  canTransitionGoal,
  canTransitionStep,
  isTerminalGoalState,
  isTerminalStepState,
  resolveGoalConstraints,
  stepNeedsApproval,
  validateGoalConstraints,
} from '../../src/domain/goal'

describe('goal state machine', () => {
  it('only lets an open goal become planned or abandoned', () => {
    expect(canTransitionGoal('open', 'planned')).toBe(true)
    expect(canTransitionGoal('open', 'running')).toBe(false)
    expect(canTransitionGoal('open', 'abandoned')).toBe(true)
  })

  it('allows a replan to return a running or failed goal to planned', () => {
    expect(canTransitionGoal('running', 'planned')).toBe(true)
    expect(canTransitionGoal('failed', 'planned')).toBe(true)
  })

  it('makes success terminal', () => {
    expect(canTransitionGoal('succeeded', 'running')).toBe(false)
    expect(canTransitionGoal('succeeded', 'abandoned')).toBe(false)
  })
})

describe('step state machine', () => {
  it('lets a failed step be retried or replanned', () => {
    expect(canTransitionStep('failed', 'ready')).toBe(true)
    expect(canTransitionStep('failed', 'abandoned')).toBe(true)
  })

  it('never revives a succeeded step', () => {
    expect(canTransitionStep('succeeded', 'ready')).toBe(false)
    expect(canTransitionStep('succeeded', 'running')).toBe(false)
  })

  it('never lets a blocked step run directly', () => {
    expect(canTransitionStep('blocked', 'running')).toBe(false)
    expect(canTransitionStep('blocked', 'ready')).toBe(true)
  })

  it('lets a pending step become blocked when its dependency can never succeed', () => {
    expect(canTransitionStep('pending', 'blocked')).toBe(true)
  })
})

describe('terminality', () => {
  it('classifies goal states', () => {
    expect(isTerminalGoalState('succeeded')).toBe(true)
    expect(isTerminalGoalState('failed')).toBe(true)
    expect(isTerminalGoalState('abandoned')).toBe(true)
    expect(isTerminalGoalState('running')).toBe(false)
    expect(isTerminalGoalState('planned')).toBe(false)
  })

  it('classifies step states', () => {
    expect(isTerminalStepState('succeeded')).toBe(true)
    expect(isTerminalStepState('blocked')).toBe(false)
    expect(isTerminalStepState('ready')).toBe(false)
  })
})

describe('goal constraints', () => {
  it('defaults to a bounded, non-destructive goal', () => {
    expect(resolveGoalConstraints(undefined)).toEqual(DEFAULT_GOAL_CONSTRAINTS)
    expect(DEFAULT_GOAL_CONSTRAINTS.allowDestructive).toBe(false)
    expect(DEFAULT_GOAL_CONSTRAINTS.maxStepAttempts).toBeGreaterThan(0)
  })

  it('keeps the defaults for fields the caller omits', () => {
    expect(resolveGoalConstraints({ maxSteps: 3 })).toEqual({
      ...DEFAULT_GOAL_CONSTRAINTS,
      maxSteps: 3,
    })
  })

  it('rejects non-positive and non-integer limits', () => {
    expect(validateGoalConstraints({ maxSteps: 0 }).length).toBe(1)
    expect(validateGoalConstraints({ maxStepAttempts: 1.5 }).length).toBe(1)
    expect(validateGoalConstraints({ maxGoalAttempts: -2 }).length).toBe(1)
  })

  it('refuses limits above the hard ceiling', () => {
    const issues = validateGoalConstraints({ maxSteps: GOAL_LIMITS.maxSteps + 1 })
    expect(issues[0]?.message).toContain(`at most ${GOAL_LIMITS.maxSteps}`)
  })

  it('rejects a non-boolean allowDestructive', () => {
    expect(validateGoalConstraints({ allowDestructive: 'yes' }).length).toBe(1)
  })

  it('rejects a non-object', () => {
    expect(validateGoalConstraints(null).length).toBe(1)
  })
})

describe('stepNeedsApproval', () => {
  it('requires approval only for an unapproved destructive action', () => {
    expect(stepNeedsApproval({ command: 'restore', args: [] }, null)).toBe(true)
    expect(stepNeedsApproval({ command: 'restore', args: [] }, 'os:roy')).toBe(false)
    expect(stepNeedsApproval({ command: 'backup', args: [] }, null)).toBe(false)
  })
})
