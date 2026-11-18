import type { ErrorClass } from '../domain/errors'

const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '40', '53', '57', '58'])
const PERMANENT_SQLSTATE_CLASSES = new Set(['25', '28', '42'])

/** Extracts the first labelled SQLSTATE (`SQL state: 42P01`) from stderr. */
export function extractSqlState(stderr: string): string | null {
  const match = /(?:SQL\s*state|SQLSTATE)\s*[:= ]\s*([0-9A-Z]{5})/i.exec(stderr)
  return match?.[1]?.toUpperCase() ?? null
}

interface SignatureRule {
  /** Stable name recorded on a step attempt; safe to key memory on. */
  readonly name: string
  readonly pattern: RegExp
}

/**
 * Signatures derived from docs/failure-catalog.md. Manual checks run before
 * SQLSTATE classes because a 42501 permission error is a human decision even
 * though its class is otherwise permanent.
 *
 * The names are part of the persisted failure record, so changing one is a
 * schema change: memory entries key on them.
 */
const MANUAL_SIGNATURES: readonly SignatureRule[] = [
  { name: 'auth:password', pattern: /password authentication failed/i },
  { name: 'auth:pg-hba', pattern: /no pg_hba\.conf entry/i },
  { name: 'auth:permission-denied', pattern: /permission denied/i },
  { name: 'auth:not-replication-role', pattern: /must be superuser or replication role/i },
  { name: 'auth:password-file-mode', pattern: /password file .* group or world access/i },
  { name: 'schema:role-missing', pattern: /role ".*" does not exist/i },
  { name: 'schema:extension-missing', pattern: /extension ".*" is not available/i },
  {
    name: 'pitr:target-not-reached',
    pattern: /recovery ended before configured recovery target/i,
  },
  // Emitted by the PITR target assertion once recovery ended without pausing at
  // the target: the archive cannot supply it, so a retry cannot succeed.
  { name: 'pitr:target-not-reached', pattern: /pitr target not reached/i },
  {
    name: 'pitr:before-consistent-point',
    pattern: /requested recovery stop point is before consistent recovery point/i,
  },
  { name: 'verify:manifest-missing-file', pattern: /present in the manifest but not on disk/i },
  {
    name: 'verify:manifest-size-mismatch',
    pattern: /has size \d+ on disk but size \d+ in the manifest/i,
  },
  { name: 'verify:manifest-unparseable', pattern: /could not parse backup manifest/i },
  { name: 'resource:disk-full', pattern: /No space left on device|\bENOSPC\b/i },
  { name: 'pitr:cannot-promote', pattern: /cannot promote/i },
]

const TRANSIENT_SIGNATURES: readonly SignatureRule[] = [
  { name: 'timeout:statement', pattern: /canceling statement due to statement timeout/i },
  { name: 'timeout:lock', pattern: /lock timeout/i },
  { name: 'connect:refused', pattern: /could not connect/i },
  { name: 'connect:reset', pattern: /connection reset/i },
  { name: 'connect:too-many-clients', pattern: /too many clients/i },
  { name: 'resource:too-many-files', pattern: /Too many open files/i },
  // Used by the PITR promotion probe: still in recovery forces 1/0.
  { name: 'probe:division-by-zero', pattern: /division by zero/i },
]

const PERMANENT_SIGNATURES: readonly SignatureRule[] = [
  { name: 'format:unsupported-version', pattern: /unsupported version .* in file header/i },
  { name: 'schema:database-missing', pattern: /database ".*" does not exist/i },
  { name: 'schema:already-exists', pattern: /already exists/i },
  { name: 'pitr:multiple-targets', pattern: /multiple recovery targets specified/i },
  { name: 'schema:read-only', pattern: /read-only transaction/i },
]

function matchRule(rules: readonly SignatureRule[], value: string): SignatureRule | null {
  return rules.find((rule) => rule.pattern.test(value)) ?? null
}

function matchesAny(rules: readonly SignatureRule[], value: string): boolean {
  return matchRule(rules, value) !== null
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

/**
 * The stable signature of a failure. This is what long-term memory keys on and
 * what a diagnosis cites, so it must be deterministic for the same failure and
 * must not embed volatile detail such as a pid or a timestamp.
 */
export function failureSignature(result: ClassifiableFailure): string {
  if (result.timedOut) return 'timeout'

  const manual = matchRule(MANUAL_SIGNATURES, result.stderr)
  if (manual !== null) return manual.name

  const sqlState = extractSqlState(result.stderr)
  if (sqlState !== null) return `sqlstate:${sqlState}`

  const transient = matchRule(TRANSIENT_SIGNATURES, result.stderr)
  if (transient !== null) return transient.name

  const permanent = matchRule(PERMANENT_SIGNATURES, result.stderr)
  if (permanent !== null) return permanent.name

  if (result.exitCode === 126 || result.exitCode === 127) return 'exit:command-unavailable'
  if (result.signal !== null) return `signal:${result.signal}`
  return `exit:${result.exitCode}`
}

export interface StepFailure {
  readonly errorClass: ErrorClass
  readonly signature: string
}

/**
 * Classifies a failed `bkagent` invocation.
 *
 * A signature the catalog recognises wins over the CLI's own exit code: an
 * authentication failure exits 3 (`CONNECT_FAILED`) like any other connection
 * problem, but it is a human decision, not something to retry. The exit code is
 * consulted only when stderr says nothing the taxonomy knows.
 */
export function classifyStepFailure(result: ClassifiableFailure): StepFailure {
  if (result.timedOut) return { errorClass: 'transient', signature: 'timeout' }

  const signature = failureSignature(result)
  const recognised = !signature.startsWith('exit:') && !signature.startsWith('signal:')
  if (recognised) return { errorClass: classifyRunResult(result), signature }

  if (result.exitCode === 3) return { errorClass: 'transient', signature: 'connect:refused' }
  if (result.exitCode === 2) return { errorClass: 'permanent', signature: 'usage:invalid-action' }
  if (result.exitCode === 4) return { errorClass: 'manual', signature: 'plan:rejected' }
  // A command that exits 0 without an outcome is a defect, not a retry target.
  if (result.exitCode === 0) return { errorClass: 'permanent', signature }
  return { errorClass: classifyRunResult(result), signature }
}
