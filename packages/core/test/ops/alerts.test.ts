import { describe, expect, it } from 'vitest'

import { evaluateAlerts, hasPageWorthyAlert } from '../../src/ops/alerts'
import type { AssetRpoStatus } from '../../src/ops/assets'

const NOW = new Date('2026-11-12T10:00:00.000Z')

function assetRpo(overrides: Partial<AssetRpoStatus> = {}): AssetRpoStatus {
  return {
    targetId: 'pg-prod',
    rpoMinutes: 60,
    lastVerifiedAt: '2026-11-12T09:30:00.000Z',
    ageMinutes: 30,
    withinRpo: true,
    verifiedLevel: 'V2',
    ...overrides,
  }
}

describe('alert ladder', () => {
  it('raises P1 when there is no verified restore point', () => {
    const alerts = evaluateAlerts({
      now: NOW,
      assets: [
        assetRpo({
          lastVerifiedAt: null,
          ageMinutes: null,
          withinRpo: false,
          verifiedLevel: null,
        }),
      ],
      attempts: [],
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.severity).toBe('P1')
    expect(alerts[0]?.labels?.['reason']).toBe('no-vrp')
    expect(hasPageWorthyAlert(alerts)).toBe(true)
  })

  it('raises P1 when the newest restore point is older than the RPO', () => {
    const alerts = evaluateAlerts({
      now: NOW,
      assets: [assetRpo({ withinRpo: false, ageMinutes: 180 })],
      attempts: [],
    })
    expect(alerts[0]?.severity).toBe('P1')
    expect(alerts[0]?.labels?.['reason']).toBe('vrp-too-old')
    expect(alerts[0]?.message).toContain('180m')
  })

  it('counts only the current consecutive failure streak per target', () => {
    const attempts = [
      // newest first by finishedAt; the streak is broken by the older success
      { targetId: 'pg-prod', state: 'failed', finishedAt: '2026-11-12T09:00:00.000Z' },
      { targetId: 'pg-prod', state: 'stalled', finishedAt: '2026-11-12T08:00:00.000Z' },
      { targetId: 'pg-prod', state: 'failed', finishedAt: '2026-11-12T07:00:00.000Z' },
      { targetId: 'pg-prod', state: 'succeeded', finishedAt: '2026-11-12T06:00:00.000Z' },
    ]
    const alerts = evaluateAlerts({ now: NOW, assets: [], attempts })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.severity).toBe('P2')
    expect(alerts[0]?.labels?.['streak']).toBe('3')
  })

  it('does not raise P2 below the streak threshold', () => {
    const alerts = evaluateAlerts({
      now: NOW,
      assets: [],
      attempts: [
        { targetId: 'pg-prod', state: 'failed', finishedAt: '2026-11-12T09:00:00.000Z' },
        { targetId: 'pg-prod', state: 'succeeded', finishedAt: '2026-11-12T08:00:00.000Z' },
      ],
    })
    expect(alerts).toEqual([])
  })

  it('raises P3 for an overdue verification and keeps P1 out of a healthy target', () => {
    const alerts = evaluateAlerts({
      now: NOW,
      assets: [assetRpo({ ageMinutes: 10 * 24 * 60 })],
      attempts: [],
      policy: { verifyOverdueDays: 7 },
    })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.severity).toBe('P3')
  })

  it('raises P4 when the capacity threshold is inside the horizon', () => {
    const alerts = evaluateAlerts({
      now: NOW,
      assets: [],
      attempts: [],
      capacity: { daysUntilThreshold: 12 },
      policy: { capacityHorizonDays: 30 },
    })
    expect(alerts[0]?.severity).toBe('P4')
    expect(hasPageWorthyAlert(alerts)).toBe(false)
  })

  it('orders by severity then target', () => {
    const alerts = evaluateAlerts({
      now: NOW,
      assets: [
        assetRpo({ targetId: 'pg-b', withinRpo: false, ageMinutes: 120 }),
        assetRpo({ targetId: 'pg-a', withinRpo: false, ageMinutes: 120 }),
      ],
      attempts: [],
    })
    expect(alerts.map((alert) => alert.labels?.['targetId'])).toEqual(['pg-a', 'pg-b'])
  })
})
