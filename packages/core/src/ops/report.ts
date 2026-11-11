export interface ReportArtifact {
  id: string
  provider: string
  kind: string
  sizeBytes: number
  createdAt: string
  verifiedLevel: string | null
}

export interface ReportAttempt {
  state: string
  errorClass?: string | null
}

export interface OpsReport {
  periodStart: string
  periodEnd: string
  artifacts: number
  totalBytes: number
  verifiedArtifacts: number
  verificationRate: number
  lastArtifactAt: string | null
  attempts: number
  failedAttempts: number
  failureRate: number
  failuresByClass: Record<string, number>
}

export function buildOpsReport(input: {
  since: string
  now: string
  artifacts: readonly ReportArtifact[]
  attempts: readonly ReportAttempt[]
}): OpsReport {
  const verified = input.artifacts.filter(
    (artifact) => artifact.verifiedLevel !== null && artifact.verifiedLevel !== undefined,
  )
  const failed = input.attempts.filter((attempt) => attempt.state === 'failed')
  const failuresByClass: Record<string, number> = {}
  for (const attempt of failed) {
    const key = attempt.errorClass ?? 'unknown'
    failuresByClass[key] = (failuresByClass[key] ?? 0) + 1
  }
  const lastArtifactAt = input.artifacts
    .map((artifact) => artifact.createdAt)
    .sort()
    .at(-1) ?? null

  return {
    periodStart: input.since,
    periodEnd: input.now,
    artifacts: input.artifacts.length,
    totalBytes: input.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
    verifiedArtifacts: verified.length,
    verificationRate: input.artifacts.length === 0 ? 0 : verified.length / input.artifacts.length,
    lastArtifactAt,
    attempts: input.attempts.length,
    failedAttempts: failed.length,
    failureRate: input.attempts.length === 0 ? 0 : failed.length / input.attempts.length,
    failuresByClass,
  }
}

export function renderReportMarkdown(report: OpsReport): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
  const lines = [
    `# Backup report (${report.periodStart} → ${report.periodEnd})`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Artifacts | ${report.artifacts} |`,
    `| Total bytes | ${report.totalBytes} |`,
    `| Verified artifacts | ${report.verifiedArtifacts} |`,
    `| Verification rate | ${percent(report.verificationRate)} |`,
    `| Last artifact | ${report.lastArtifactAt ?? '(none)'} |`,
    `| Attempts | ${report.attempts} |`,
    `| Failed attempts | ${report.failedAttempts} |`,
    `| Failure rate | ${percent(report.failureRate)} |`,
  ]
  const classes = Object.entries(report.failuresByClass)
  if (classes.length > 0) {
    lines.push('', '## Failures by class', '', '| Class | Count |', '|---|---|')
    for (const [name, count] of classes) lines.push(`| ${name} | ${count} |`)
  }
  return `${lines.join('\n')}\n`
}
