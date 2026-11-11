import type { ErrorClass } from '../domain/errors'

const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '40', '53', '57', '58'])
const PERMANENT_SQLSTATE_CLASSES = new Set(['25', '28', '42'])

/** Extracts the first labelled SQLSTATE (`SQL state: 42P01`) from stderr. */
export function extractSqlState(stderr: string): string | null {
  const match = /(?:SQL\s*state|SQLSTATE)\s*[:= ]\s*([0-9A-Z]{5})/i.exec(stderr)
  return match?.[1]?.toUpperCase() ?? null
}

/**
 * Signatures derived from docs/failure-catalog.md. Manual checks run before
 * SQLSTATE classes because a 42501 permission error is a human decision even
 * though its class is otherwise permanent.
 */
const MANUAL_SIGNATURES: readonly RegExp[] = [
  /password authentication failed/i,
  /no pg_hba\.conf entry/i,
  /permission denied/i,
  /must be superuser or replication role/i,
  /password file .* group or world access/i,
  /role ".*" does not exist/i,
  /extension ".*" is not available/i,
  /recovery ended before configured recovery target/i,
  /requested recovery stop point is before consistent recovery point/i,
  /present in the manifest but not on disk/i,
  /has size \d+ on disk but size \d+ in the manifest/i,
  /could not parse backup manifest/i,
  /No space left on device|\bENOSPC\b/i,
  /cannot promote/i,
]

const TRANSIENT_SIGNATURES: readonly RegExp[] = [
  /canceling statement due to statement timeout/i,
  /lock timeout/i,
  /could not connect/i,
  /connection reset/i,
  /too many clients/i,
  /Too many open files/i,
]

const PERMANENT_SIGNATURES: readonly RegExp[] = [
  /unsupported version .* in file header/i,
  /database ".*" does not exist/i,
  /already exists/i,
  /multiple recovery targets specified/i,
  /read-only transaction/i,
]

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value))
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
  if (matchesAny(MANUAL_SIGNATURES, result.stderr)) return 'manual'

  const sqlState = extractSqlState(result.stderr)
  if (sqlState) {
    const stateClass = sqlState.slice(0, 2)
    if (TRANSIENT_SQLSTATE_CLASSES.has(stateClass)) return 'transient'
    if (PERMANENT_SQLSTATE_CLASSES.has(stateClass)) return 'permanent'
  }

  if (matchesAny(TRANSIENT_SIGNATURES, result.stderr)) return 'transient'
  if (matchesAny(PERMANENT_SIGNATURES, result.stderr)) return 'permanent'
  if (result.exitCode === 126 || result.exitCode === 127) return 'permanent'
  if (result.signal) return 'manual'
  if (result.exitCode === 0) return 'permanent'
  return 'permanent'
}
