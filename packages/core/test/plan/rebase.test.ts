import { describe, expect, it } from 'vitest'

import { rebasePlan } from '../../src/plan/rebase'
import { makePlan, NOW } from '../fixtures/plan'

describe('rebasePlan', () => {
  it('leaves an unchanged plan alone', () => {
    const plan = makePlan()
    expect(rebasePlan(plan, plan.fingerprint, NOW)).toEqual({ kind: 'unchanged' })
  })

  it('aborts when the target identity changes', () => {
    const plan = makePlan()
    const result = rebasePlan(plan, { ...plan.fingerprint, systemIdentifier: 'sys-2' }, NOW)
    expect(result.kind).toBe('abort')
    if (result.kind === 'abort') expect(result.changed).toEqual(['systemIdentifier'])
  })

  it('replans with a new id on configuration drift', () => {
    const plan = makePlan()
    const current = { ...plan.fingerprint, configDigest: 'cfg-2' }
    const result = rebasePlan(plan, current, NOW)
    expect(result.kind).toBe('replan')
    if (result.kind === 'replan') {
      expect(result.reason).toBe('config-changed')
      expect(result.plan.planId).not.toBe(plan.planId)
      expect(result.plan.fingerprint).toEqual(current)
      expect(result.plan.steps).toEqual(plan.steps)
    }
  })

  it('replans when the fingerprint expired', () => {
    const plan = makePlan()
    const result = rebasePlan(plan, plan.fingerprint, '2026-01-01T03:00:00.000Z')
    expect(result.kind).toBe('replan')
    if (result.kind === 'replan') expect(result.reason).toBe('fingerprint-expired')
  })

  it('does not mutate the input plan', () => {
    const plan = makePlan()
    const originalId = plan.planId
    rebasePlan(plan, { ...plan.fingerprint, configDigest: 'cfg-2' }, NOW)
    expect(plan.planId).toBe(originalId)
    expect(plan.fingerprint.configDigest).toBe('cfg-1')
  })
})
