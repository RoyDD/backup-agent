export interface MetricsArtifact {
  provider: string
  kind: string
  sizeBytes: number
  createdAt: string
}

export interface MetricsAttempt {
  state: string
  errorClass?: string | null
}

/** One finished attempt, already reduced to a duration by the caller. */
export interface MetricsAttemptDuration {
  state: string
  seconds: number
}

export interface MetricsInput {
  artifacts: readonly MetricsArtifact[]
  attempts: readonly MetricsAttempt[]
  outboxPending: number
  /**
   * Current ticket rows per state (`TicketStore.countByState`). Counts, not a
   * monotonic counter: a ticket that transitions moves between keys.
   */
  ticketsByState: Readonly<Record<string, number>>
  /** Current attempt rows per state (`AttemptStore.countByState`). */
  attemptsByState: Readonly<Record<string, number>>
  /** Finished attempts only; running attempts have no duration yet. */
  attemptDurations: readonly MetricsAttemptDuration[]
  /** Cataloged backup bytes per provider, tombstones already excluded. */
  backupBytesByProvider: readonly { provider: string; bytes: number }[]
  /** Catalog rows carrying recorded verification evidence per level. */
  verifyLevels: readonly { level: string; count: number }[]
  /** `OutboxStats.oldestPendingAt`; null when nothing is pending. */
  outboxOldestPendingAt: string | null
  rpo: { assets: number; withinRpo: number }
  now: number
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/** Prometheus rejects NaN/Infinity text values; a broken sample reads as 0. */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function labels(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([key, label]) => `${key}="${escapeLabel(label)}"`)
    .join(',')
  return `{${body}}`
}

function sample(name: string, fields: Record<string, string>, value: number): string {
  return `${name}${labels(fields)} ${finite(value)}`
}

function bare(name: string, value: number): string {
  return `${name} ${finite(value)}`
}

/** Prometheus text exposition; no external client required. */
export function renderMetrics(input: MetricsInput): string {
  const lines: string[] = []
  // Both *_total series below count rows currently in the database. They are
  // named *_total by plan §12 and existing dashboards, so they keep the name,
  // but the HELP text says what they are so nobody applies rate() to a state
  // census.
  lines.push(
    '# HELP bk_artifacts_total Artifact catalog rows recorded to date, by provider and kind (gauge: rows recorded to date; tombstones and retention do not decrement it, so it is not a monotonic event counter).',
  )
  lines.push('# TYPE bk_artifacts_total gauge')
  const artifactGroups = new Map<string, { provider: string; kind: string; count: number }>()
  for (const artifact of input.artifacts) {
    const key = `${artifact.provider}/${artifact.kind}`
    const existing = artifactGroups.get(key)
    if (existing) existing.count += 1
    else artifactGroups.set(key, { provider: artifact.provider, kind: artifact.kind, count: 1 })
  }
  for (const group of artifactGroups.values()) {
    lines.push(sample('bk_artifacts_total', { provider: group.provider, kind: group.kind }, group.count))
  }

  lines.push('# HELP bk_artifact_bytes_total Bytes recorded per provider (gauge: tombstones and retention can reduce it).')
  lines.push('# TYPE bk_artifact_bytes_total gauge')
  const bytes = new Map<string, number>()
  for (const artifact of input.artifacts) {
    bytes.set(artifact.provider, (bytes.get(artifact.provider) ?? 0) + artifact.sizeBytes)
  }
  for (const [provider, value] of bytes) {
    lines.push(sample('bk_artifact_bytes_total', { provider }, value))
  }

  lines.push(
    '# HELP bk_attempts_total Attempt rows recorded to date, by state (gauge: rows recorded to date; tombstones and retention do not decrement it, so it is not a monotonic event counter).',
  )
  lines.push('# TYPE bk_attempts_total gauge')
  const states = new Map<string, number>()
  for (const attempt of input.attempts) {
    states.set(attempt.state, (states.get(attempt.state) ?? 0) + 1)
  }
  for (const [state, value] of states) {
    lines.push(sample('bk_attempts_total', { state }, value))
  }

  lines.push('# HELP bk_attempt_errors_total Failed attempts by error class.')
  lines.push('# TYPE bk_attempt_errors_total gauge')
  const errors = new Map<string, number>()
  for (const attempt of input.attempts) {
    if (attempt.state !== 'failed') continue
    const key = attempt.errorClass ?? 'unknown'
    errors.set(key, (errors.get(key) ?? 0) + 1)
  }
  for (const [errorClass, value] of errors) {
    lines.push(sample('bk_attempt_errors_total', { error_class: errorClass }, value))
  }

  lines.push('# HELP bk_ticket_total Current ticket rows per state (gauge: tickets transition between states, this is not a monotonic counter).')
  lines.push('# TYPE bk_ticket_total gauge')
  for (const [state, value] of Object.entries(input.ticketsByState)) {
    lines.push(sample('bk_ticket_total', { state }, value))
  }

  // Summary surface: each state with at least one finished attempt exposes the
  // `_sum`/`_count` pair Prometheus derives `rate()`/`_avg` from.
  lines.push('# HELP bk_attempt_duration_seconds Wall-clock duration of finished attempts, by terminal state.')
  lines.push('# TYPE bk_attempt_duration_seconds summary')
  const durations = new Map<string, { sum: number; count: number }>()
  for (const entry of input.attemptDurations) {
    if (!Number.isFinite(entry.seconds)) continue
    const existing = durations.get(entry.state)
    if (existing) {
      existing.sum += entry.seconds
      existing.count += 1
    } else {
      durations.set(entry.state, { sum: entry.seconds, count: 1 })
    }
  }
  for (const [state, aggregate] of durations) {
    lines.push(sample('bk_attempt_duration_seconds_sum', { state }, aggregate.sum))
    lines.push(sample('bk_attempt_duration_seconds_count', { state }, aggregate.count))
  }

  lines.push(
    '# HELP bk_backup_bytes_total Cataloged backup bytes per provider (gauge: the catalog is not a monotonic counter, tombstones and retention can reduce it).',
  )
  lines.push('# TYPE bk_backup_bytes_total gauge')
  for (const entry of input.backupBytesByProvider) {
    lines.push(sample('bk_backup_bytes_total', { provider: entry.provider }, entry.bytes))
  }

  lines.push(
    '# HELP bk_verify_result_total Catalog rows carrying recorded verification evidence, by level (gauge). Only passes are recorded today, so result is always "ok"; a failed verification is not written as a row.',
  )
  lines.push('# TYPE bk_verify_result_total gauge')
  for (const entry of input.verifyLevels) {
    lines.push(sample('bk_verify_result_total', { level: entry.level, result: 'ok' }, entry.count))
  }

  lines.push(
    '# HELP bk_outbox_lag_seconds Age in seconds of the oldest pending Outbox record; 0 when nothing is pending.',
  )
  lines.push('# TYPE bk_outbox_lag_seconds gauge')
  if (input.outboxOldestPendingAt === null) {
    lines.push(bare('bk_outbox_lag_seconds', 0))
  } else {
    const oldest = Date.parse(input.outboxOldestPendingAt)
    // An unparseable timestamp is a data defect: expose the series (HELP/TYPE
    // above) but emit no sample rather than a fabricated lag.
    if (Number.isFinite(oldest)) {
      lines.push(bare('bk_outbox_lag_seconds', Math.max(0, (input.now - oldest) / 1000)))
    }
  }

  lines.push('# HELP bk_outbox_pending Pending outbox records.')
  lines.push('# TYPE bk_outbox_pending gauge')
  lines.push(bare('bk_outbox_pending', input.outboxPending))

  lines.push(
    '# HELP bk_stalled_attempts_total Attempts in the terminal stalled state written by startup reconciliation (lease lost); not a lease-expiry count.',
  )
  lines.push('# TYPE bk_stalled_attempts_total gauge')
  lines.push(bare('bk_stalled_attempts_total', input.attemptsByState['stalled'] ?? 0))

  const assets = finite(input.rpo.assets)
  const withinRpo = finite(input.rpo.withinRpo)
  const ratio = assets > 0 ? withinRpo / assets : 0
  lines.push(
    '# HELP bk_rpo_attainment_ratio Share of tracked assets with a VRP inside their RPO window (within_rpo / assets); 0 when no assets are tracked.',
  )
  lines.push('# TYPE bk_rpo_attainment_ratio gauge')
  lines.push(`bk_rpo_attainment_ratio ${finite(ratio).toFixed(6)}`)

  const last = input.artifacts
    .map((artifact) => Date.parse(artifact.createdAt))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0]
  lines.push('# HELP bk_last_artifact_timestamp_seconds Unix time of the newest artifact.')
  lines.push('# TYPE bk_last_artifact_timestamp_seconds gauge')
  lines.push(bare('bk_last_artifact_timestamp_seconds', last === undefined ? 0 : Math.floor(last / 1000)))

  lines.push(`# scraped_at ${new Date(input.now).toISOString()}`)
  return `${lines.join('\n')}\n`
}
