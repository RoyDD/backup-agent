import type { ErrorClass } from '../domain/errors'

const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58'])
const PERMANENT_SQLSTATE_CLASSES = new Set(['28', '42'])

/** Extracts the first labelled SQLSTATE (`SQL state: 42P01`) from stderr. */
export function extractSqlState(stderr: string): string | null {
  const match = /(?:SQL\s*state|SQLSTATE)\s*[:= ]\s*([0-9A-Z]{5})/i.exec(stderr)
  return match?.[1]?.toUpperCase() ?? null
}

export interface ClassifiableFailure {
  timedOut: boolean
  signal: string | null
  exitCode: number
  stderr: string
}

/**
 * Maps a failed RunResult onto the retry taxonomy. Callers classify only
 * failures; exit code 0 is reported as `permanent` so the function is total.
 */
export function classifyRunResult(result: ClassifiableFailure): ErrorClass {
  if (result.timedOut) return 'transient'
  if (/EACCES|EPERM|permission denied/i.test(result.stderr)) return 'manual'
  if (/No space left on device|\b53100\b/i.test(result.stderr)) return 'manual'

  const sqlState = extractSqlState(result.stderr)
  if (sqlState) {
    const stateClass = sqlState.slice(0, 2)
    if (TRANSIENT_SQLSTATE_CLASSES.has(stateClass)) return 'transient'
    if (PERMANENT_SQLSTATE_CLASSES.has(stateClass)) return 'permanent'
  }

  if (result.exitCode === 126 || result.exitCode === 127) return 'permanent'
  if (result.signal) return 'manual'
  if (result.exitCode === 0) return 'permanent'
  return 'permanent'
}
