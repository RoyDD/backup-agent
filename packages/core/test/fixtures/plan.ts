import { asMandateId, asPlanId, asTargetId, asTicketId } from '../../src/domain/ids'
import type { Plan, Step } from '../../src/domain/plan'
import type { PlanValidationContext } from '../../src/plan/validate'
import type { MandateRecord } from '../../src/ports/repository'

export const NOW = '2026-01-01T01:00:00.000Z'

export function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    stepId: 'dump',
    kind: 'exec',
    dependsOn: [],
    argv: ['pg_dump', '-Fc'],
    preconditions: [],
    postconditions: [],
    retry: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      backoff: 'exponential',
      retryOn: ['transient'],
    },
    checkpoint: 'after',
    idempotencyKey: 'dump-1',
    ...overrides,
  }
}

export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: asPlanId('pln_test'),
    ticketId: asTicketId('tkt_test'),
    mandateId: asMandateId('mnd_test'),
    engine: 'postgres',
    provider: 'native-logical',
    targetId: asTargetId('pg-prod'),
    fingerprint: {
      systemIdentifier: 'sys-1',
      configDigest: 'cfg-1',
      targetOid: 'oid-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T02:00:00.000Z',
    },
    steps: [makeStep()],
    resources: {
      estimatedBytes: 1_000,
      estimatedDurationMs: 5_000,
      concurrencySlots: 1,
    },
    risk: 'reversible',
    ...overrides,
  }
}

export function makeMandate(overrides: Partial<MandateRecord> = {}): MandateRecord {
  return {
    id: asMandateId('mnd_test'),
    ticketId: asTicketId('tkt_test'),
    principalId: 'user:roy',
    scope: 'backup',
    policyVersion: '1',
    allowedRisk: 'destructive',
    issuedAt: '2026-01-01T00:30:00.000Z',
    expiresAt: '2026-01-01T03:00:00.000Z',
    ...overrides,
  }
}

export function makeContext(
  overrides: Partial<PlanValidationContext> = {},
): PlanValidationContext {
  return {
    now: NOW,
    declaredCapabilities: new Set(['logical', 'catalog']),
    requiredCapabilities: ['logical'],
    mandate: makeMandate(),
    resources: {
      availableBytes: 10_000,
      maxConcurrency: 2,
    },
    policyValid: true,
    ...overrides,
  }
}
