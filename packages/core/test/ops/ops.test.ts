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
  const base = {
    now: Date.parse('2026-02-01T00:00:00.000Z'),
    artifacts: [
      { provider: 'pgbackrest', kind: 'full', sizeBytes: 100, createdAt: '2026-01-31T00:00:00.000Z' },
    ],
    attempts: [
      { state: 'failed', errorClass: 'transient' },
      { state: 'succeeded' },
    ],
    outboxPending: 2,
    ticketsByState: { open: 3, succeeded: 1 },
    attemptsByState: { succeeded: 1, failed: 1, stalled: 1 },
    attemptDurations: [
      { state: 'succeeded', seconds: 12 },
      { state: 'succeeded', seconds: 8 },
      { state: 'failed', seconds: 5 },
    ],
    backupBytesByProvider: [{ provider: 'pgbackrest', bytes: 4_096 }],
    verifyLevels: [
      { level: 'V1', count: 2 },
      { level: 'V2', count: 1 },
    ],
    outboxOldestPendingAt: '2026-01-31T23:59:30.000Z',
    rpo: { assets: 4, withinRpo: 3 },
  } as const

  it('renders Prometheus exposition', () => {
    const text = renderMetrics(base)
    // Pre-existing series keep their numbers and label sets.
    expect(text).toContain('bk_artifacts_total{provider="pgbackrest",kind="full"} 1')
    expect(text).toContain('bk_artifact_bytes_total{provider="pgbackrest"} 100')
    expect(text).toContain('bk_attempts_total{state="succeeded"} 1')
    expect(text).toContain('bk_attempt_errors_total{error_class="transient"} 1')
    expect(text).toContain('bk_outbox_pending 2')
    expect(text).toContain('bk_last_artifact_timestamp_seconds')

    // §12 series.
    expect(text).toContain('bk_ticket_total{state="open"} 3')
    expect(text).toContain('bk_ticket_total{state="succeeded"} 1')
    expect(text).toContain('bk_attempt_duration_seconds_sum{state="succeeded"} 20')
    expect(text).toContain('bk_attempt_duration_seconds_count{state="succeeded"} 2')
    expect(text).toContain('bk_attempt_duration_seconds_sum{state="failed"} 5')
    expect(text).toContain('# TYPE bk_attempt_duration_seconds summary')
    expect(text).toContain('bk_backup_bytes_total{provider="pgbackrest"} 4096')
    expect(text).toContain('bk_verify_result_total{level="V1",result="ok"} 2')
    expect(text).toContain('bk_verify_result_total{level="V2",result="ok"} 1')
    expect(text).toContain('bk_outbox_lag_seconds 30')
    expect(text).toContain('bk_stalled_attempts_total 1')
    expect(text).toContain('bk_rpo_attainment_ratio 0.750000')

    // These *_total series are gauges, and their HELP admits non-monotonicity.
    expect(text).toMatch(/# TYPE bk_ticket_total gauge/)
    expect(text).toMatch(/# TYPE bk_backup_bytes_total gauge/)
    expect(text).toMatch(/# TYPE bk_verify_result_total gauge/)
    expect(text).toMatch(/# TYPE bk_attempts_total gauge/)
    expect(text).toMatch(/# TYPE bk_artifacts_total gauge/)
    expect(text).toContain('tombstones and retention do not decrement it')
  })

  it('skips duration samples for states with no finished attempt', () => {
    const text = renderMetrics({ ...base, attemptDurations: [] })
    expect(text).toContain('# TYPE bk_attempt_duration_seconds summary')
    expect(text).not.toContain('bk_attempt_duration_seconds_sum{')
    expect(text).not.toContain('bk_attempt_duration_seconds_count{')
  })

  it('reports zero outbox lag when nothing is pending', () => {
    const text = renderMetrics({ ...base, outboxOldestPendingAt: null, outboxPending: 0 })
    expect(text).toContain('bk_outbox_lag_seconds 0')
  })

  it('omits the lag sample when the pending timestamp is unparseable', () => {
    const text = renderMetrics({ ...base, outboxOldestPendingAt: 'not-a-timestamp' })
    expect(text).toContain('# TYPE bk_outbox_lag_seconds gauge')
    expect(text).not.toMatch(/^bk_outbox_lag_seconds /m)
  })

  it('clamps a future pending timestamp to zero lag', () => {
    const text = renderMetrics({ ...base, outboxOldestPendingAt: '2026-02-01T00:00:05.000Z' })
    expect(text).toContain('bk_outbox_lag_seconds 0')
  })

  it('reports rpo 0 for zero assets instead of NaN', () => {
    const text = renderMetrics({ ...base, rpo: { assets: 0, withinRpo: 0 } })
    expect(text).toContain('bk_rpo_attainment_ratio 0.000000')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('Infinity')
  })

  it('reports stalled attempts from the reconciled state, not a caller-supplied count', () => {
    const text = renderMetrics({ ...base, attemptsByState: { succeeded: 2 } })
    expect(text).toContain('bk_stalled_attempts_total 0')
  })

  it('emits 0 instead of NaN for non-finite input values', () => {
    const text = renderMetrics({
      ...base,
      outboxPending: Number.NaN,
      attemptDurations: [{ state: 'succeeded', seconds: Number.POSITIVE_INFINITY }],
      backupBytesByProvider: [{ provider: 'pgbackrest', bytes: Number.NEGATIVE_INFINITY }],
    })
    expect(text).toContain('bk_outbox_pending 0')
    expect(text).toContain('bk_backup_bytes_total{provider="pgbackrest"} 0')
    expect(text).not.toContain('NaN')
    expect(text).not.toContain('Infinity')
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
