import { describe, expect, it } from 'vitest'

import type { StepAction } from '../../src/domain/action'
import type { GoalConstraints, GoalStep, StepState } from '../../src/domain/goal'
import { asGoalId, asGoalStepId, type GoalStepId } from '../../src/domain/ids'
import {
  blockedStepIds,
  goalProgress,
  nextRunnable,
  validateDecomposition,
} from '../../src/ops/goal-plan'

const GOAL_ID = asGoalId('goal-1')
const AT = '2026-03-01T00:00:00.000Z'

const CONSTRAINTS: GoalConstraints = {
  maxSteps: 5,
  maxStepAttempts: 3,
  maxGoalAttempts: 9,
  allowDestructive: false,
}

function makeStep(options: {
  ordinal: number
  state: StepState
  dependsOn?: readonly GoalStepId[]
  action?: StepAction
  id?: string
}): GoalStep {
  return {
    stepId: asGoalStepId(options.id ?? `step-${options.ordinal}`),
    goalId: GOAL_ID,
    ordinal: options.ordinal,
    intent: `step ${options.ordinal}`,
    action: options.action ?? { command: 'inspect', args: [] },
    dependsOn: options.dependsOn ?? [],
    state: options.state,
    attempts: 0,
    maxAttempts: 3,
    planId: null,
    approvedBy: null,
    approvedAt: null,
    lastErrorClass: null,
    createdAt: AT,
    updatedAt: AT,
  }
}

function stepId(value: number | string): GoalStepId {
  return asGoalStepId(typeof value === 'number' ? `step-${value}` : value)
}

function runStep(steps: readonly GoalStep[]): GoalStep {
  const outcome = nextRunnable(steps)
  if (outcome.kind !== 'run') {
    throw new Error(`expected a runnable step, got ${outcome.kind}`)
  }
  return outcome.step
}

describe('validateDecomposition', () => {
  it('refuses a goal with no steps', () => {
    expect(validateDecomposition(CONSTRAINTS, [])).toEqual([
      { step: 0, field: 'steps', message: 'a goal needs at least one step' },
    ])
  })

  it('refuses more steps than the goal allows', () => {
    const steps = [1, 2, 3].map((ordinal) => ({
      intent: `step ${ordinal}`,
      action: { command: 'inspect', args: [] },
    }))
    const issues = validateDecomposition({ ...CONSTRAINTS, maxSteps: 2 }, steps)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.step).toBe(0)
    expect(issues[0]?.field).toBe('steps')
    expect(issues[0]?.message).toContain('at most 2')
  })

  it('refuses a blank intent', () => {
    const issues = validateDecomposition(CONSTRAINTS, [
      { intent: '   ', action: { command: 'inspect', args: [] } },
    ])
    expect(issues).toEqual([
      { step: 1, field: 'intent', message: 'intent must be a non-empty string' },
    ])
  })

  it('refuses an action outside the grammar', () => {
    const issues = validateDecomposition(CONSTRAINTS, [
      { intent: 'try it', action: { command: 'inspect', args: ['--yes'] } },
    ])
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((issue) => issue.step === 1 && issue.field === 'action')).toBe(true)
    expect(issues.some((issue) => issue.message.includes('--yes'))).toBe(true)
  })

  it('refuses a destructive action unless the goal opted in', () => {
    const steps = [
      { intent: 'restore it', action: { command: 'restore', args: ['--input', '/tmp/backup'] } },
    ]
    expect(validateDecomposition(CONSTRAINTS, steps)).toEqual([
      { step: 1, field: 'action', message: 'the goal does not allow destructive steps' },
    ])
    expect(
      validateDecomposition({ ...CONSTRAINTS, allowDestructive: true }, steps),
    ).toEqual([])
  })

  it('refuses a forward dependency', () => {
    const issues = validateDecomposition(CONSTRAINTS, [
      { intent: 'first', action: { command: 'inspect', args: [] }, dependsOn: [2] },
      { intent: 'second', action: { command: 'inspect', args: [] } },
    ])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.step).toBe(1)
    expect(issues[0]?.field).toBe('dependsOn')
    expect(issues[0]?.message).toContain('earlier step')
  })

  it('refuses a self dependency', () => {
    const issues = validateDecomposition(CONSTRAINTS, [
      { intent: 'first', action: { command: 'inspect', args: [] }, dependsOn: [1] },
    ])
    expect(issues).toEqual([
      { step: 1, field: 'dependsOn', message: 'a step must not depend on itself' },
    ])
  })

  it('refuses a maxAttempts above the goal limit', () => {
    const issues = validateDecomposition(CONSTRAINTS, [
      { intent: 'first', action: { command: 'inspect', args: [] }, maxAttempts: 5 },
    ])
    expect(issues).toEqual([
      { step: 1, field: 'maxAttempts', message: 'maxAttempts must be at most 3' },
    ])
  })

  it('accepts a valid three-step chain', () => {
    const steps = [
      { intent: 'inspect the target', action: { command: 'inspect', args: [] } },
      { intent: 'take a backup', action: { command: 'backup', args: ['--out', '/tmp/backup'] }, dependsOn: [1] },
      {
        intent: 'verify the backup',
        action: { command: 'verify', args: ['--input', '/tmp/backup'] },
        dependsOn: [1, 2],
        maxAttempts: 2,
      },
    ]
    expect(validateDecomposition(CONSTRAINTS, steps)).toEqual([])
  })
})

describe('nextRunnable', () => {
  it('returns empty for a goal with no steps', () => {
    expect(nextRunnable([])).toEqual({ kind: 'empty' })
  })

  it('prefers the first ready step by ordinal', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'pending' }),
      makeStep({ ordinal: 2, state: 'ready' }),
      makeStep({ ordinal: 3, state: 'ready' }),
    ]
    expect(runStep(steps).stepId).toBe(stepId(2))
  })

  it('falls through to a pending step whose dependencies succeeded', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'succeeded' }),
      makeStep({ ordinal: 2, state: 'pending', dependsOn: [stepId(1)] }),
      makeStep({ ordinal: 3, state: 'pending', dependsOn: [stepId(2)] }),
    ]
    expect(runStep(steps).stepId).toBe(stepId(2))
  })

  it('reports blocked when a dependency failed', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'failed' }),
      makeStep({ ordinal: 2, state: 'pending', dependsOn: [stepId(1)] }),
    ]
    expect(nextRunnable(steps)).toEqual({
      kind: 'blocked',
      stepIds: [stepId(2)],
    })
  })

  it('reports blocked when a dependency id does not exist', () => {
    const steps = [makeStep({ ordinal: 1, state: 'pending', dependsOn: [stepId('ghost')] })]
    expect(nextRunnable(steps)).toEqual({
      kind: 'blocked',
      stepIds: [stepId(1)],
    })
  })

  it('reports done with failed: true when a step failed and nothing is runnable', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'failed' }),
      makeStep({ ordinal: 2, state: 'succeeded' }),
    ]
    expect(nextRunnable(steps)).toEqual({ kind: 'done', failed: true })
  })

  it('propagates blocked along a dependency chain and then finishes', () => {
    const failedA = [
      makeStep({ ordinal: 1, state: 'failed', id: 'a' }),
      makeStep({ ordinal: 2, state: 'pending', id: 'b', dependsOn: [stepId('a')] }),
      makeStep({ ordinal: 3, state: 'pending', id: 'c', dependsOn: [stepId('b')] }),
    ]
    expect(nextRunnable(failedA)).toEqual({ kind: 'blocked', stepIds: [stepId('b')] })

    const blockedB = [
      makeStep({ ordinal: 1, state: 'failed', id: 'a' }),
      makeStep({ ordinal: 2, state: 'blocked', id: 'b', dependsOn: [stepId('a')] }),
      makeStep({ ordinal: 3, state: 'pending', id: 'c', dependsOn: [stepId('b')] }),
    ]
    expect(nextRunnable(blockedB)).toEqual({ kind: 'blocked', stepIds: [stepId('c')] })

    const blockedC = [
      makeStep({ ordinal: 1, state: 'failed', id: 'a' }),
      makeStep({ ordinal: 2, state: 'blocked', id: 'b', dependsOn: [stepId('a')] }),
      makeStep({ ordinal: 3, state: 'blocked', id: 'c', dependsOn: [stepId('b')] }),
    ]
    expect(nextRunnable(blockedC)).toEqual({ kind: 'done', failed: true })
  })

  it('reports done when only blocked steps remain', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'blocked' }),
      makeStep({ ordinal: 2, state: 'succeeded' }),
    ]
    expect(nextRunnable(steps)).toEqual({ kind: 'done', failed: true })
  })

  it('reports done with failed: false when every step succeeded', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'succeeded' }),
      makeStep({ ordinal: 2, state: 'succeeded' }),
    ]
    expect(nextRunnable(steps)).toEqual({ kind: 'done', failed: false })
  })

  it('waits when a dependency is merely pending', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'running' }),
      makeStep({ ordinal: 2, state: 'pending', dependsOn: [stepId(1)] }),
    ]
    expect(nextRunnable(steps)).toEqual({ kind: 'waiting' })
  })
})

describe('blockedStepIds', () => {
  it('returns only the steps with a failed, abandoned, blocked or missing dependency', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'failed' }),
      makeStep({ ordinal: 2, state: 'abandoned' }),
      makeStep({ ordinal: 3, state: 'pending', dependsOn: [stepId(1)] }),
      makeStep({ ordinal: 4, state: 'pending', dependsOn: [stepId(2)] }),
      makeStep({ ordinal: 5, state: 'pending', dependsOn: [stepId('ghost')] }),
      makeStep({ ordinal: 6, state: 'pending' }),
      makeStep({ ordinal: 7, state: 'succeeded' }),
      makeStep({ ordinal: 8, state: 'pending', dependsOn: [stepId(7)] }),
      makeStep({ ordinal: 9, state: 'blocked' }),
      makeStep({ ordinal: 10, state: 'pending', dependsOn: [stepId(9)] }),
    ]
    expect(blockedStepIds(steps)).toEqual([stepId(3), stepId(4), stepId(5), stepId(10)])
  })
})

describe('goalProgress', () => {
  it('counts each state', () => {
    const steps = [
      makeStep({ ordinal: 1, state: 'pending' }),
      makeStep({ ordinal: 2, state: 'ready' }),
      makeStep({ ordinal: 3, state: 'running' }),
      makeStep({ ordinal: 4, state: 'succeeded' }),
      makeStep({ ordinal: 5, state: 'failed' }),
      makeStep({ ordinal: 6, state: 'blocked' }),
      makeStep({ ordinal: 7, state: 'abandoned' }),
    ]
    expect(goalProgress(steps)).toEqual({
      total: 7,
      succeeded: 1,
      failed: 1,
      abandoned: 1,
      ready: 1,
      pending: 1,
      blocked: 1,
    })
  })
})
