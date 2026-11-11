import { describe, expect, it } from 'vitest'

import { asTargetId } from '../../src/domain/ids'
import { validateAsset, type AssetDescriptor } from '../../src/domain/asset'
import { missingCapabilities } from '../../src/domain/capabilities'
import { requiresApproval, riskAtLeast } from '../../src/domain/risk'
import { validatePrincipal } from '../../src/domain/principal'
import { resolveModelPolicy, validateModelPolicy } from '../../src/domain/model-policy'
import {
  canTransitionAttempt,
  canTransitionPlan,
  canTransitionTicket,
} from '../../src/domain/state'

const asset: AssetDescriptor = {
  targetId: asTargetId('pg-prod'),
  engine: 'postgres',
  environment: 'production',
  owner: 'dba-team',
  criticality: 'critical',
  dataClassification: 'confidential',
  rpoMinutes: 15,
  rtoMinutes: 60,
  protected: true,
}

describe('AssetDescriptor', () => {
  it('accepts a complete descriptor', () => {
    expect(validateAsset(asset)).toEqual([])
  })

  it('rejects missing semantics and invalid numbers', () => {
    const issues = validateAsset({
      ...asset,
      owner: ' ',
      environment: 'prod' as never,
      rpoMinutes: 0,
    })
    expect(issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(['owner', 'environment', 'rpoMinutes']),
    )
  })
})

describe('Principal', () => {
  it('requires an id and a known kind', () => {
    expect(validatePrincipal({ id: 'user:roy', kind: 'human' })).toEqual([])
    expect(validatePrincipal({ id: '', kind: 'human' })).toHaveLength(1)
    expect(validatePrincipal({ id: 'x', kind: 'robot' as never })).toHaveLength(1)
  })
})

describe('ModelPolicy', () => {
  it('validates and resolves by task', () => {
    const policy = { task: 'diagnose' as const, model: 'deepseek-v4', tokenBudget: 8000, maxOutputChars: 4000 }
    expect(validateModelPolicy(policy)).toEqual([])
    expect(resolveModelPolicy({ policies: [policy], defaultTokenBudget: 1000 }, 'diagnose')).toEqual(policy)
    expect(resolveModelPolicy({ policies: [policy], defaultTokenBudget: 1000 }, 'intent')).toBeUndefined()
  })

  it('rejects non-positive budgets', () => {
    expect(
      validateModelPolicy({ task: 'plan', model: 'm', tokenBudget: 0, maxOutputChars: 10 }),
    ).toHaveLength(1)
  })
})

describe('risk and capabilities', () => {
  it('orders risk levels and gates approval', () => {
    expect(riskAtLeast('destructive', 'reversible')).toBe(true)
    expect(riskAtLeast('read-only', 'reversible')).toBe(false)
    expect(requiresApproval('reversible')).toBe(false)
    expect(requiresApproval('destructive')).toBe(true)
  })

  it('reports undeclared capabilities', () => {
    expect(missingCapabilities(['logical', 'pitr'], new Set(['logical']))).toEqual(['pitr'])
  })
})

describe('state machines', () => {
  it('allows only declared transitions', () => {
    expect(canTransitionTicket('open', 'scheduled')).toBe(true)
    expect(canTransitionTicket('succeeded', 'in_progress')).toBe(false)
    expect(canTransitionPlan('validated', 'approved')).toBe(true)
    expect(canTransitionPlan('drafted', 'dispatched')).toBe(false)
    expect(canTransitionAttempt('running', 'stalled')).toBe(true)
    expect(canTransitionAttempt('stalled', 'running')).toBe(false)
  })
})
