import { describe, expect, it } from 'vitest'

import { asGoalStepId } from '../../src/domain/ids'
import {
  APPROVAL_REQUIRED_SIGNATURE,
  autoRemediation,
  decideRemediation,
  diagnose,
  isRemediationKind,
  type DiagnoseInput,
} from '../../src/domain/remediation'

const stepId = asGoalStepId('gst_1')

function input(overrides: Partial<DiagnoseInput> = {}): DiagnoseInput {
  return {
    stepId,
    errorClass: 'transient',
    signature: 'connect:refused',
    exitCode: 3,
    attempts: 1,
    maxAttempts: 3,
    goalAttempts: 1,
    maxGoalAttempts: 9,
    action: { command: 'backup', args: ['--out', '/tmp/x.dump'] },
    approvedBy: null,
    ...overrides,
  }
}

const kinds = (diagnosis: ReturnType<typeof diagnose>): string[] =>
  diagnosis.candidates.map((candidate) => candidate.kind)

describe('diagnose', () => {
  it('offers retry for a transient failure with budget left', () => {
    const diagnosis = diagnose(input())
    expect(kinds(diagnosis)).toEqual(['retry', 'escalate'])
    expect(diagnosis.requiresHuman).toBe(false)
    expect(autoRemediation(diagnosis)?.kind).toBe('retry')
  })

  it('stops offering retry once the step budget is exhausted', () => {
    const diagnosis = diagnose(input({ attempts: 3, maxAttempts: 3 }))
    expect(kinds(diagnosis)).toEqual(['escalate', 'abandon'])
    expect(diagnosis.requiresHuman).toBe(true)
    expect(autoRemediation(diagnosis)).toBeNull()
  })

  it('stops offering retry once the goal budget is exhausted', () => {
    const diagnosis = diagnose(input({ goalAttempts: 9, maxGoalAttempts: 9 }))
    expect(kinds(diagnosis)).not.toContain('retry')
    expect(autoRemediation(diagnosis)).toBeNull()
  })

  it('offers replan for a permanent failure, because the plan is what is wrong', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'sqlstate:42P01', exitCode: 1 }))
    expect(kinds(diagnosis)).toEqual(['replan', 'escalate'])
    expect(diagnosis.requiresHuman).toBe(false)
    expect(diagnosis.candidates.find((c) => c.kind === 'replan')?.requiresAction).toBe(true)
  })

  it('never auto-applies a replan', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'sqlstate:42P01' }))
    expect(autoRemediation(diagnosis)).toBeNull()
  })

  it('sends a manual failure to a human', () => {
    const diagnosis = diagnose(input({ errorClass: 'manual', signature: 'auth:password', exitCode: 1 }))
    expect(kinds(diagnosis)).toEqual(['escalate', 'abandon'])
    expect(diagnosis.requiresHuman).toBe(true)
  })

  it('treats a missing approval as manual and never offers a replan', () => {
    const diagnosis = diagnose(
      input({ errorClass: 'transient', signature: 'connect:refused', action: { command: 'restore', args: [] } }),
    )
    expect(diagnosis.signature).toBe(APPROVAL_REQUIRED_SIGNATURE)
    expect(diagnosis.errorClass).toBe('manual')
    expect(kinds(diagnosis)).toEqual(['escalate'])
    expect(kinds(diagnosis)).not.toContain('replan')
    expect(kinds(diagnosis)).not.toContain('retry')
  })

  it('honours an explicit approval signature even for a non-destructive action', () => {
    const diagnosis = diagnose(input({ signature: APPROVAL_REQUIRED_SIGNATURE }))
    expect(kinds(diagnosis)).toEqual(['escalate'])
    expect(diagnosis.requiresHuman).toBe(true)
  })

  it('lets an approved destructive action be diagnosed normally', () => {
    const diagnosis = diagnose(
      input({
        action: { command: 'restore', args: [] },
        approvedBy: 'os:roy',
        errorClass: 'permanent',
        signature: 'schema:database-missing',
      }),
    )
    expect(kinds(diagnosis)).toEqual(['replan', 'escalate'])
  })
})

describe('decideRemediation', () => {
  it('applies a retry offered by the diagnosis', () => {
    const diagnosis = diagnose(input())
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'retry',
      stepState: 'failed',
      goalState: 'running',
    })
    expect(decision).toEqual({ ok: true, kind: 'retry', stepState: 'ready', goalState: 'running' })
  })

  it('refuses a remediation outside the closed set', () => {
    const diagnosis = diagnose(input({ errorClass: 'manual', signature: 'auth:password' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'retry',
      stepState: 'failed',
      goalState: 'running',
    })
    expect(decision.ok).toBe(false)
    expect(decision.ok === false ? decision.reason : '').toContain('not an available remediation')
  })

  it('refuses a replan without a replacement action', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'schema:database-missing' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'replan',
      stepState: 'failed',
      goalState: 'running',
    })
    expect(decision.ok).toBe(false)
  })

  it('refuses a replacement action that breaks the capability grammar', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'schema:database-missing' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'replan',
      stepState: 'failed',
      goalState: 'running',
      action: { command: 'restore', args: ['--input', '/b/a.dump', '--yes'] },
    })
    expect(decision.ok).toBe(false)
    expect(decision.ok === false ? decision.reason : '').toContain('replacement action rejected')
  })

  it('accepts a replan with a valid replacement action', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'schema:database-missing' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'replan',
      stepState: 'failed',
      goalState: 'running',
      action: { command: 'inspect', args: ['--dsn', 'postgres://u@h/db'] },
    })
    expect(decision.ok).toBe(true)
    expect(decision.ok === true ? decision.stepState : '').toBe('ready')
    expect(decision.ok === true ? decision.goalState : '').toBe('planned')
  })

  it('refuses a replan that introduces a destructive action into a non-destructive goal', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'schema:database-missing' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'replan',
      stepState: 'failed',
      goalState: 'running',
      action: { command: 'restore', args: ['--input', '/b/a.dump'] },
    })
    expect(decision.ok).toBe(false)
    expect(decision.ok === false ? decision.reason : '').toContain('does not allow destructive steps')
  })

  it('accepts a destructive replan only when the goal opted in', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'schema:database-missing' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: true,
      kind: 'replan',
      stepState: 'failed',
      goalState: 'running',
      action: { command: 'restore', args: ['--input', '/b/a.dump'] },
    })
    expect(decision.ok).toBe(true)
  })

  it('refuses a replan from a terminal goal state', () => {
    const diagnosis = diagnose(input({ errorClass: 'permanent', signature: 'schema:database-missing' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'replan',
      stepState: 'failed',
      goalState: 'succeeded',
      action: { command: 'inspect', args: [] },
    })
    expect(decision.ok).toBe(false)
  })

  it('escalates to a failed goal', () => {
    const diagnosis = diagnose(input({ errorClass: 'manual', signature: 'auth:password' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'escalate',
      stepState: 'failed',
      goalState: 'running',
    })
    expect(decision).toEqual({ ok: true, kind: 'escalate', stepState: 'failed', goalState: 'failed' })
  })

  it('abandons the step and the goal together', () => {
    const diagnosis = diagnose(input({ errorClass: 'manual', signature: 'auth:password' }))
    const decision = decideRemediation({
      diagnosis,
      allowDestructive: false,
      kind: 'abandon',
      stepState: 'failed',
      goalState: 'running',
    })
    expect(decision).toEqual({ ok: true, kind: 'abandon', stepState: 'abandoned', goalState: 'abandoned' })
  })
})

describe('isRemediationKind', () => {
  it('accepts only the four kinds', () => {
    expect(isRemediationKind('retry')).toBe(true)
    expect(isRemediationKind('replan')).toBe(true)
    expect(isRemediationKind('escalate')).toBe(true)
    expect(isRemediationKind('abandon')).toBe(true)
    expect(isRemediationKind('ignore')).toBe(false)
  })
})
