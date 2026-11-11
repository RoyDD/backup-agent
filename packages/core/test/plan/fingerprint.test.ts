import { describe, expect, it } from 'vitest'

import { canonicalJson, fingerprintPlan, matchFingerprint } from '../../src/plan/fingerprint'
import { makePlan, NOW } from '../fixtures/plan'

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}')
  })

  it('drops undefined members', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('fingerprintPlan', () => {
  it('is stable for equal content', () => {
    expect(fingerprintPlan(makePlan())).toBe(fingerprintPlan(makePlan()))
  })

  it('changes when executable content changes', () => {
    const changed = makePlan({ steps: [{ ...makePlan().steps[0]!, argv: ['pg_dump', '-Fd'] }] })
    expect(fingerprintPlan(changed)).not.toBe(fingerprintPlan(makePlan()))
  })
})

describe('matchFingerprint', () => {
  const plan = makePlan()
  const current = plan.fingerprint

  it('matches identical fingerprints', () => {
    expect(matchFingerprint(plan, current, NOW)).toEqual({ ok: true })
  })

  it('reports expiry first', () => {
    expect(matchFingerprint(plan, current, '2026-01-01T03:00:00.000Z')).toEqual({
      ok: false,
      reason: 'expired',
      changed: ['expiresAt'],
    })
  })

  it('reports identity drift before configuration drift', () => {
    expect(
      matchFingerprint(plan, { ...current, systemIdentifier: 'sys-2', configDigest: 'cfg-2' }, NOW),
    ).toEqual({ ok: false, reason: 'identity-mismatch', changed: ['systemIdentifier'] })
  })

  it('reports configuration drift', () => {
    expect(matchFingerprint(plan, { ...current, configDigest: 'cfg-2' }, NOW)).toEqual({
      ok: false,
      reason: 'config-mismatch',
      changed: ['configDigest'],
    })
  })
})
