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

export interface MetricsInput {
  artifacts: readonly MetricsArtifact[]
  attempts: readonly MetricsAttempt[]
  outboxPending: number
  stalledAttempts: number
  now: number
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function counter(name: string, labels: Record<string, string>, value: number): string {
  const body = Object.entries(labels)
    .map(([key, label]) => `${key}="${escapeLabel(label)}"`)
    .join(',')
  return `${name}{${body}} ${value}`
}

/** Prometheus text exposition; no external client required. */
export function renderMetrics(input: MetricsInput): string {
  const lines: string[] = []
  lines.push('# HELP bk_artifacts_total Artifacts recorded by provider and kind.')
  lines.push('# TYPE bk_artifacts_total gauge')
  const artifactGroups = new Map<string, { provider: string; kind: string; count: number }>()
  for (const artifact of input.artifacts) {
    const key = `${artifact.provider}/${artifact.kind}`
    const existing = artifactGroups.get(key)
    if (existing) existing.count += 1
    else artifactGroups.set(key, { provider: artifact.provider, kind: artifact.kind, count: 1 })
  }
  for (const group of artifactGroups.values()) {
    lines.push(
      counter('bk_artifacts_total', { provider: group.provider, kind: group.kind }, group.count),
    )
  }

  lines.push('# HELP bk_artifact_bytes_total Bytes recorded per provider.')
  lines.push('# TYPE bk_artifact_bytes_total gauge')
  const bytes = new Map<string, number>()
  for (const artifact of input.artifacts) {
    bytes.set(artifact.provider, (bytes.get(artifact.provider) ?? 0) + artifact.sizeBytes)
  }
  for (const [provider, value] of bytes) {
    lines.push(counter('bk_artifact_bytes_total', { provider }, value))
  }

  lines.push('# HELP bk_attempts_total Attempts by terminal state.')
  lines.push('# TYPE bk_attempts_total gauge')
  const states = new Map<string, number>()
  for (const attempt of input.attempts) {
    states.set(attempt.state, (states.get(attempt.state) ?? 0) + 1)
  }
  for (const [state, value] of states) {
    lines.push(counter('bk_attempts_total', { state }, value))
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
    lines.push(counter('bk_attempt_errors_total', { error_class: errorClass }, value))
  }

  lines.push('# HELP bk_outbox_pending Pending outbox records.')
  lines.push('# TYPE bk_outbox_pending gauge')
  lines.push(`bk_outbox_pending ${input.outboxPending}`)

  lines.push('# HELP bk_stalled_attempts_total Stalled attempts detected at startup.')
  lines.push('# TYPE bk_stalled_attempts_total gauge')
  lines.push(`bk_stalled_attempts_total ${input.stalledAttempts}`)

  const last = input.artifacts
    .map((artifact) => Date.parse(artifact.createdAt))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0]
  lines.push('# HELP bk_last_artifact_timestamp_seconds Unix time of the newest artifact.')
  lines.push('# TYPE bk_last_artifact_timestamp_seconds gauge')
  lines.push(`bk_last_artifact_timestamp_seconds ${last === undefined ? 0 : Math.floor(last / 1000)}`)

  lines.push(`# scraped_at ${new Date(input.now).toISOString()}`)
  return `${lines.join('\n')}\n`
}
