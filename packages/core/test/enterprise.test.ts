import { describe, expect, it } from 'vitest'

import { evaluateAssetRpo } from '../src/ops/assets'
import {
  escalateRisk,
  fourEyesStatus,
  requiredApprovals,
} from '../src/security/four-eyes'
import {
  checkBudget,
  estimateCost,
  parseModelPolicy,
  policyFor,
} from '../src/ops/model-cost'
import { preparePlan } from '../src/plan/prepare'
import {
  parsePrincipalRegistry,
  PrincipalError,
  resolvePrincipalDsn,
} from '../src/security/principal-registry'
import type { PlanFingerprint } from '../src/domain/plan'
import type { ArtifactRecord } from '../src/ports/repository'
import { asTargetId } from '../src/domain/ids'
import { NOW, makePlan, makeMandate } from './fixtures/plan'

describe('preparePlan', () => {
  const plan = makePlan()

  it('replans when the fingerprint expired', async () => {
    const current: PlanFingerprint = {
      ...plan.fingerprint,
      createdAt: NOW,
      expiresAt: '2027-01-01T00:00:00.000Z',
    }
    let refreshes = 0
    const result = await preparePlan({
      plan,
      refresh: async () => {
        refreshes += 1
        return current
      },
      validate: () => [],
      now: () => '2026-01-01T03:00:00.000Z',
    })
    expect(refreshes).toBe(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.plan.planId).not.toBe(plan.planId)
  })

  it('aborts on target identity change', async () => {
    const result = await preparePlan({
      plan,
      refresh: async () => ({ ...plan.fingerprint, systemIdentifier: 'sys-2' }),
      validate: () => [],
      now: () => NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('identity-changed')
  })

  it('escalates non-fingerprint validation failures', async () => {
    const result = await preparePlan({
      plan,
      refresh: async () => plan.fingerprint,
      validate: () => [{ code: 'PERMISSION', path: 'risk', message: 'denied' }],
      now: () => NOW,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('validation-failed')
  })
})

describe('principal registry', () => {
  const registry = parsePrincipalRegistry({
    version: 1,
    principals: [{ id: 'user:roy', kind: 'human', dsnEnv: 'ROY_DSN' }],
  })

  it('resolves a DSN from the environment', () => {
    expect(resolvePrincipalDsn(registry, 'user:roy', { ROY_DSN: 'postgres://x' })).toBe(
      'postgres://x',
    )
  })

  it('fails closed for unknown principals and missing secrets', () => {
    expect(() => resolvePrincipalDsn(registry, 'user:ghost', {})).toThrow(PrincipalError)
    expect(() => resolvePrincipalDsn(registry, 'user:roy', {})).toThrow(/empty/)
  })

  it('rejects duplicate principals', () => {
    expect(() =>
      parsePrincipalRegistry({
        version: 1,
        principals: [
          { id: 'a', kind: 'human', dsnEnv: 'A' },
          { id: 'a', kind: 'human', dsnEnv: 'B' },
        ],
      }),
    ).toThrow(/duplicate/)
  })
})

describe('model cost policy', () => {
  const policy = {
    task: 'diagnose',
    model: 'deepseek-v4',
    tokenBudget: 1000,
    maxOutputChars: 500,
    inputPer1k: 0.1,
    outputPer1k: 0.2,
  }

  it('estimates cost and enforces budgets', () => {
    const usage = { task: 'diagnose', model: 'deepseek-v4', inputTokens: 600, outputTokens: 300 }
    expect(estimateCost(usage, policy)).toBeCloseTo(0.12)
    const check = checkBudget(usage, policy)
    expect(check.allowed).toBe(true)
    expect(check.remainingTokens).toBe(100)

    const over = checkBudget({ ...usage, inputTokens: 900 }, policy)
    expect(over.allowed).toBe(false)
    expect(over.reason).toBe('over-token-budget')

    const tooLong = checkBudget({ ...usage, outputTokens: 600 }, policy)
    expect(tooLong.reason).toBe('over-output-limit')
  })

  it('parses a policy document and resolves by task', () => {
    const document = parseModelPolicy({ version: 1, policies: [policy] })
    expect(policyFor(document, 'diagnose')).toEqual(policy)
    expect(policyFor(document, 'intent')).toBeUndefined()
    expect(() => parseModelPolicy({ version: 2, policies: [] })).toThrow()
  })
})

describe('asset RPO', () => {
  const asset = {
    targetId: asTargetId('pg-prod'),
    engine: 'postgres',
    environment: 'production' as const,
    owner: 'dba',
    criticality: 'critical' as const,
    dataClassification: 'confidential' as const,
    rpoMinutes: 60,
    rtoMinutes: 120,
    protected: true,
  }

  const artifact = (overrides: Partial<ArtifactRecord>): ArtifactRecord => ({
    id: 'art_1' as never,
    planId: null,
    targetId: asTargetId('pg-prod'),
    provider: 'pgbackrest',
    kind: 'full',
    parentId: null,
    path: '/repo',
    sizeBytes: 1,
    checksum: null,
    verifiedLevel: 'V2',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    protected: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  })

  it('uses verified artifacts only', () => {
    const now = new Date('2026-01-01T00:30:00.000Z')
    const within = evaluateAssetRpo([asset], [artifact({})], now)
    expect(within[0]?.withinRpo).toBe(true)

    const stale = evaluateAssetRpo(
      [asset],
      [artifact({ createdAt: '2025-12-31T00:00:00.000Z' })],
      now,
    )
    expect(stale[0]?.withinRpo).toBe(false)

    const unverified = evaluateAssetRpo([asset], [artifact({ verifiedLevel: null })], now)
    expect(unverified[0]?.lastVerifiedAt).toBeNull()
    expect(unverified[0]?.withinRpo).toBe(false)
  })
})

// keep the mandate import used for fixture consistency in this file
void makeMandate

describe('four-eyes approvals', () => {
  const now = new Date('2026-01-01T01:00:00.000Z')
  const approval = (approver: string, at = '2026-01-01T00:30:00.000Z', decision: 'approve' | 'reject' = 'approve') => ({
    approver,
    decision,
    createdAt: at,
  })

  it('requires two distinct approvers for production-destructive plans', () => {
    expect(requiredApprovals('production-destructive')).toBe(2)
    expect(requiredApprovals('destructive')).toBe(0)
    expect(fourEyesStatus('production-destructive', [approval('alice')], now)).toEqual({
      required: 2,
      distinct: 1,
      ok: false,
      reason: 'insufficient-approvals',
    })
    expect(
      fourEyesStatus('production-destructive', [approval('alice'), approval('bob')], now).ok,
    ).toBe(true)
  })

  it('ignores rejects, duplicates and expired approvals', () => {
    const status = fourEyesStatus(
      'production-destructive',
      [approval('alice'), approval('alice'), approval('bob', '2026-01-01T00:30:00.000Z', 'reject')],
      now,
    )
    expect(status.distinct).toBe(1)
    expect(status.ok).toBe(false)

    const expired = fourEyesStatus(
      'production-destructive',
      [approval('alice', '2025-01-01T00:00:00.000Z'), approval('bob', '2025-01-01T00:00:00.000Z')],
      now,
    )
    expect(expired.ok).toBe(false)
  })

  it('resolves one decision per approver with the latest decision winning', () => {
    const superseded = fourEyesStatus(
      'production-destructive',
      [
        approval('alice', '2026-01-01T00:10:00.000Z', 'approve'),
        approval('alice', '2026-01-01T00:20:00.000Z', 'reject'),
        approval('bob', '2026-01-01T00:20:00.000Z', 'approve'),
      ],
      now,
    )
    expect(superseded.distinct).toBe(1)
    expect(superseded.ok).toBe(false)

    const reversed = fourEyesStatus(
      'production-destructive',
      [
        approval('alice', '2026-01-01T00:10:00.000Z', 'reject'),
        approval('alice', '2026-01-01T00:20:00.000Z', 'approve'),
        approval('bob', '2026-01-01T00:20:00.000Z', 'approve'),
      ],
      now,
    )
    expect(reversed.ok).toBe(true)
  })

  it('ignores future-dated approvals', () => {
    const status = fourEyesStatus(
      'production-destructive',
      [approval('alice', '2026-01-01T02:00:00.000Z'), approval('bob')],
      now,
    )
    expect(status.distinct).toBe(1)
    expect(status.ok).toBe(false)
  })

  it('excludes requester self-approval from the distinct count', () => {
    const status = fourEyesStatus(
      'production-destructive',
      [approval('os:roy'), approval('alice'), approval('bob')],
      now,
      3_600_000,
      ['os:roy', 'os:roy'],
    )
    expect(status.distinct).toBe(2)
    expect(status.ok).toBe(true)
    expect(status.selfApproved).toEqual(['os:roy'])
  })

  it('escalates every destructive plan on a production asset', () => {
    const production = {
      targetId: asTargetId('pg-prod'),
      engine: 'postgres',
      environment: 'production' as const,
      owner: 'dba',
      criticality: 'critical' as const,
      dataClassification: 'confidential' as const,
      rpoMinutes: 60,
      rtoMinutes: 120,
      protected: true,
    }
    expect(escalateRisk('destructive', production)).toBe('production-destructive')
    // `protected` is a retention flag, not a four-eyes bypass.
    expect(escalateRisk('destructive', { ...production, protected: false })).toBe(
      'production-destructive',
    )
    expect(escalateRisk('destructive', { ...production, environment: 'staging' })).toBe(
      'destructive',
    )
    expect(escalateRisk('reversible', production)).toBe('reversible')
    expect(escalateRisk('destructive', null)).toBe('destructive')
  })
})
