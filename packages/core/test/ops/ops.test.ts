import { describe, expect, it } from 'vitest'

import { forecastCapacity } from '../../src/ops/capacity'
import { renderMetrics } from '../../src/ops/metrics'
import { severityForFailure, severityForRpo, WebhookNotifier } from '../../src/ops/notify'
import { buildOpsReport, renderReportMarkdown } from '../../src/ops/report'
import { planRetention, type RetentionArtifact } from '../../src/ops/retention'

const now = new Date('2026-02-01T00:00:00.000Z')

describe('planRetention', () => {
  it('keeps GFS roots plus their ancestors', () => {
    const artifacts: RetentionArtifact[] = []
    for (let day = 0; day < 10; day += 1) {
      artifacts.push({
        id: `full-${day}`,
        targetId: 'pg-prod',
        parentId: null,
        createdAt: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
        kind: 'full',
      })
    }
    const decision = planRetention(artifacts, { daily: 3, weekly: 2, monthly: 1 }, now)
    expect(decision.keep.has('full-9')).toBe(true)
    expect(decision.keep.has('full-8')).toBe(true)
    expect(decision.keep.has('full-7')).toBe(true)
    expect(decision.remove.has('full-0')).toBe(true)
    for (const id of decision.keep) expect(decision.remove.has(id)).toBe(false)
  })

  it('never breaks an incremental chain', () => {
    const artifacts: RetentionArtifact[] = [
      {
        id: 'full',
        targetId: 'pg-prod',
        parentId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'full',
      },
      {
        id: 'incr',
        targetId: 'pg-prod',
        parentId: 'full',
        createdAt: '2026-01-31T00:00:00.000Z',
        kind: 'incr',
      },
    ]
    const decision = planRetention(artifacts, { daily: 1, weekly: 0, monthly: 0 }, now)
    expect(decision.keep).toEqual(new Set(['incr', 'full']))
    expect(decision.remove.size).toBe(0)
  })

  it('always keeps protected artifacts', () => {
    const artifacts: RetentionArtifact[] = [
      {
        id: 'old',
        targetId: 'pg-prod',
        parentId: null,
        createdAt: '2025-01-01T00:00:00.000Z',
        kind: 'full',
        protected: true,
      },
      {
        id: 'new',
        targetId: 'pg-prod',
        parentId: null,
        createdAt: '2026-01-31T00:00:00.000Z',
        kind: 'full',
      },
    ]
    const decision = planRetention(artifacts, { daily: 1, weekly: 0, monthly: 0 }, now)
    expect(decision.keep.has('old')).toBe(true)
    expect(decision.keep.has('new')).toBe(true)
  })
})

describe('buildOpsReport', () => {
  it('summarises artifacts and failures', () => {
    const report = buildOpsReport({
      since: '2026-01-01T00:00:00.000Z',
      now: '2026-02-01T00:00:00.000Z',
      artifacts: [
        { id: 'a', provider: 'pgbackrest', kind: 'full', sizeBytes: 100, createdAt: '2026-01-30T00:00:00.000Z', verifiedLevel: 'V2' },
        { id: 'b', provider: 'pgbackrest', kind: 'incr', sizeBytes: 50, createdAt: '2026-01-31T00:00:00.000Z', verifiedLevel: null },
      ],
      attempts: [
        { state: 'succeeded' },
        { state: 'failed', errorClass: 'transient' },
        { state: 'failed', errorClass: 'manual' },
      ],
    })
    expect(report.artifacts).toBe(2)
    expect(report.totalBytes).toBe(150)
    expect(report.verificationRate).toBe(0.5)
    expect(report.failureRate).toBeCloseTo(2 / 3)
    expect(report.failuresByClass).toEqual({ transient: 1, manual: 1 })
    expect(renderReportMarkdown(report)).toContain('Verification rate | 50.0%')
  })
})

describe('renderMetrics', () => {
  it('renders Prometheus exposition', () => {
    const text = renderMetrics({
      now: Date.parse('2026-02-01T00:00:00.000Z'),
      artifacts: [
        { provider: 'pgbackrest', kind: 'full', sizeBytes: 100, createdAt: '2026-01-31T00:00:00.000Z' },
      ],
      attempts: [
        { state: 'failed', errorClass: 'transient' },
        { state: 'succeeded' },
      ],
      outboxPending: 2,
      stalledAttempts: 1,
    })
    expect(text).toContain('bk_artifacts_total{provider="pgbackrest",kind="full"} 1')
    expect(text).toContain('bk_artifact_bytes_total{provider="pgbackrest"} 100')
    expect(text).toContain('bk_attempt_errors_total{error_class="transient"} 1')
    expect(text).toContain('bk_outbox_pending 2')
    expect(text).toContain('bk_stalled_attempts_total 1')
  })
})

describe('forecastCapacity', () => {
  it('projects linear growth', () => {
    const day = 86_400_000
    const points = [
      { at: 0, bytes: 100 },
      { at: day, bytes: 200 },
      { at: 2 * day, bytes: 300 },
    ]
    const forecast = forecastCapacity(points, 1000, 2 * day)
    expect(forecast.slopePerDay).toBeCloseTo(100)
    expect(forecast.daysUntilThreshold).toBeCloseTo(7)
  })

  it('returns null when the trend is flat or negative', () => {
    const forecast = forecastCapacity([{ at: 0, bytes: 500 }], 1000, 0)
    expect(forecast.daysUntilThreshold).toBeNull()
  })
})

describe('notifications', () => {
  it('posts JSON and fails on non-2xx', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const notifier = new WebhookNotifier('https://example.test/hook', async (url, init) => {
      calls.push({ url, body: init.body })
      return { ok: true, status: 200, text: async () => 'ok' }
    })
    await notifier.send({ severity: 'P2', title: 'backup failed', message: 'boom' })
    expect(calls[0]?.url).toBe('https://example.test/hook')
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ severity: 'P2', title: 'backup failed' })

    const failing = new WebhookNotifier('https://example.test/hook', async () => ({
      ok: false,
      status: 500,
      text: async () => 'error',
    }))
    await expect(
      failing.send({ severity: 'P2', title: 'x', message: 'y' }),
    ).rejects.toThrow('500')
  })

  it('maps failure classes and RPO state to severities', () => {
    expect(severityForFailure('transient')).toBe('P3')
    expect(severityForFailure('manual')).toBe('P2')
    expect(severityForRpo(false)).toBe('P1')
    expect(severityForRpo(true)).toBe('P4')
  })
})
