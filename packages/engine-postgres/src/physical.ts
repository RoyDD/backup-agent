import {
  asPlanId,
  asTargetId,
  DEFAULT_RETRY_POLICY,
  newId,
  type ConnectionParams,
  type Plan,
  type PlanBuildContext,
  type Step,
} from '@backup-agent/core'

import { fingerprintFor, targetIdFor } from './logical'

export interface PhysicalBackupRequest {
  connection: ConnectionParams
  outputPath: string
  format: 'plain' | 'tar'
  walMethod?: 'stream' | 'fetch'
  compression?: number
  checkpoint?: 'fast' | 'spread'
  label?: string
  maxRate?: string
  /** Parse WAL during verification; requires pg_waldump beside pg_verifybackup. */
  parseWal?: boolean
}

export function buildPhysicalBackupArgv(request: PhysicalBackupRequest): string[] {
  const { connection } = request
  const argv = [
    'pg_basebackup',
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--username=${connection.user}`,
    '--no-password',
    `--pgdata=${request.outputPath}`,
    `--format=${request.format}`,
    `--wal-method=${request.walMethod ?? 'stream'}`,
    `--checkpoint=${request.checkpoint ?? 'fast'}`,
  ]
  if (request.format === 'tar' && request.compression !== undefined) {
    argv.push(`--compress=${request.compression}`)
  }
  if (request.label !== undefined) argv.push(`--label=${request.label}`)
  if (request.maxRate !== undefined) argv.push(`--max-rate=${request.maxRate}`)
  return argv
}

export function buildPhysicalBackupPlan(
  request: PhysicalBackupRequest,
  ctx: PlanBuildContext,
): Plan {
  const steps: Step[] = [
    {
      stepId: 'basebackup',
      kind: 'exec',
      dependsOn: [],
      argv: buildPhysicalBackupArgv(request),
      preconditions: [],
      postconditions: [{ kind: 'fileExists', path: request.outputPath }],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `physical-basebackup:${ctx.configDigest}`,
      timeoutMs: 3_600_000,
    },
  ]

  if (request.format === 'plain') {
    steps.push({
      stepId: 'verify-backup',
      kind: 'exec',
      dependsOn: ['basebackup'],
      argv: request.parseWal === true ? ['pg_verifybackup', request.outputPath] : ['pg_verifybackup', '--no-parse-wal', request.outputPath],
      preconditions: [{ kind: 'fileExists', path: request.outputPath }],
      postconditions: [],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `physical-verify:${ctx.configDigest}`,
      timeoutMs: 600_000,
    })
  }

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'native-physical',
    targetId: asTargetId(targetIdFor(request.connection, request.connection.database)),
    fingerprint: fingerprintFor(request.connection, ctx),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    risk: 'read-only',
  }
}

export interface PitrTarget {
  time?: string
  lsn?: string
  name?: string
  xid?: string
}

export interface PitrRestoreRequest {
  connection: ConnectionParams
  dataDirectory: string
  port: string
  logPath: string
  restoreCommand: string
  target: PitrTarget
  action?: 'promote' | 'pause' | 'shutdown'
  /** Existing postgresql.auto.conf content, preserved verbatim. */
  existingAutoConf?: string
  verifySql?: string
}

function quoteConfig(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function buildPitrConfig(request: PitrRestoreRequest): string {
  const lines: string[] = []
  lines.push(`restore_command = ${quoteConfig(request.restoreCommand)}`)
  if (request.target.time !== undefined) {
    lines.push(`recovery_target_time = ${quoteConfig(request.target.time)}`)
  }
  if (request.target.lsn !== undefined) {
    lines.push(`recovery_target_lsn = ${quoteConfig(request.target.lsn)}`)
  }
  if (request.target.name !== undefined) {
    lines.push(`recovery_target_name = ${quoteConfig(request.target.name)}`)
  }
  if (request.target.xid !== undefined) {
    lines.push(`recovery_target_xid = ${quoteConfig(request.target.xid)}`)
  }
  lines.push(`recovery_target_action = ${quoteConfig(request.action ?? 'promote')}`)
  return lines.join('\n')
}

const PITR_TARGET_KINDS = ['time', 'lsn', 'name', 'xid'] as const
type PitrTargetKind = (typeof PITR_TARGET_KINDS)[number]

interface ResolvedPitrTarget {
  kind: PitrTargetKind
  value: string
}

const LSN_PATTERN = /^[0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8}$/
const XID_PATTERN = /^\d+$/

/**
 * A Plan can only prove that recovery reached the target it was configured
 * with. Exactly one target is therefore mandatory; anything else is rejected
 * at build time instead of producing a plan that would promote and report
 * success without evidence.
 */
function resolvePitrTarget(target: PitrTarget): ResolvedPitrTarget {
  const present = PITR_TARGET_KINDS.filter((kind) => target[kind] !== undefined)
  if (present.length !== 1) {
    throw new Error('PITR requires exactly one recovery target: time, lsn, name or xid')
  }
  const kind = present[0] as PitrTargetKind
  const value = target[kind] as string
  if (value.trim() === '') {
    throw new Error(`PITR target ${kind} must not be empty`)
  }
  if (kind === 'lsn' && !LSN_PATTERN.test(value)) {
    throw new Error(`PITR target lsn "${value}" is not a valid LSN`)
  }
  if (kind === 'xid' && !XID_PATTERN.test(value)) {
    throw new Error(`PITR target xid "${value}" is not a valid transaction id`)
  }
  if (kind === 'time' && !Number.isFinite(Date.parse(value))) {
    throw new Error(`PITR target time "${value}" is not a valid timestamp`)
  }
  return { kind, value }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Target-specific evidence that replay did not pass the configured target.
 * LSN and time have catalog functions to compare against; `name` and `xid`
 * have no catalog function exposing the replayed restore point or transaction
 * id, so they return no extra evidence.
 *
 * The expressions are shaped to avoid shell metacharacters (notably `<`,
 * `>`, `$`, `;`) because Plan validation rejects argv containing them.
 */
function pitrTargetEvidence(target: ResolvedPitrTarget): string[] {
  if (target.kind === 'lsn') {
    const lsn = sqlLiteral(target.value)
    return [
      `greatest(pg_wal_lsn_diff(pg_last_wal_replay_lsn(), ${lsn}::pg_lsn), 0) = pg_wal_lsn_diff(pg_last_wal_replay_lsn(), ${lsn}::pg_lsn)`,
    ]
  }
  if (target.kind === 'time') {
    const timestamp = sqlLiteral(target.value)
    return [
      `(pg_last_xact_replay_timestamp() is null or greatest(extract(epoch from (${timestamp}::timestamptz - pg_last_xact_replay_timestamp())), 0) = extract(epoch from (${timestamp}::timestamptz - pg_last_xact_replay_timestamp())))`,
    ]
  }
  return []
}

/**
 * Serializes the "pause at target then verify" assertion as SQL. A paused
 * replay state is the only portable proof that `recovery_target_*` was
 * reached: PostgreSQL ends recovery with a fatal error when the archive runs
 * out before the target, so a running-but-unpaused server must never be
 * accepted.
 */
function pitrTargetAssertionSql(target: ResolvedPitrTarget): string {
  const conditions = [
    "pg_get_wal_replay_pause_state() = 'paused'",
    'pg_last_wal_replay_lsn() is not null',
    ...pitrTargetEvidence(target),
  ]
  return `select 1 / (case when ${conditions.join(' and ')} then 1 else 0 end)`
}

/**
 * Post-promotion assertion. It repeats the target evidence so success never
 * depends solely on `pg_is_in_recovery()` becoming false; the pause assertion
 * that ran before promotion already proved attainment for every target kind.
 */
function pitrPromotedAssertionSql(target: ResolvedPitrTarget): string {
  const conditions = ['not pg_is_in_recovery()', ...pitrTargetEvidence(target)]
  return `select 1 / (case when ${conditions.join(' and ')} then 1 else 0 end)`
}

/**
 * Starts an instance in recovery from an existing base backup. The caller is
 * responsible for taking the base backup and providing a working
 * restore_command. The data directory is modified in place.
 *
 * The written configuration always uses `recovery_target_action = 'pause'`.
 * Reaching a paused state is verifiable from SQL, while `pg_is_in_recovery()`
 * becoming false only says that some recovery ended; the requested action is
 * therefore applied as an explicit step after the target assertion:
 *
 * - `promote`: `pg_ctl promote` and then assert the server left recovery.
 * - `pause`: leave the instance paused at the target (the requested state).
 * - `shutdown`: assert the target, then stop the paused instance.
 *
 * This proves the configured target was reached. It does not prove that the
 * WAL archive had no gaps beyond the target, so success must not be reported
 * as a complete PITR window or a Verified Restore Point by itself.
 */
export function buildPitrRestorePlan(request: PitrRestoreRequest, ctx: PlanBuildContext): Plan {
  const target = resolvePitrTarget(request.target)
  const action = request.action ?? 'promote'
  const existing = request.existingAutoConf ?? ''
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  const autoConf = `${existing}${separator}${buildPitrConfig({ ...request, action: 'pause' })}\n`

  const psql = [
    'psql',
    '--host=127.0.0.1',
    `--port=${request.port}`,
    `--username=${request.connection.user}`,
    '--dbname=postgres',
    '--no-password',
    '-X',
    '-A',
    '-t',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
  ]

  const waitForTargetRetry = {
    maxAttempts: 20,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    backoff: 'exponential' as const,
    retryOn: ['transient'] as const,
  }

  const steps: Step[] = [
    {
      stepId: 'write-recovery-config',
      kind: 'write-file',
      dependsOn: [],
      file: { path: `${request.dataDirectory}/postgresql.auto.conf`, content: autoConf },
      preconditions: [],
      postconditions: [],
      retry: { ...DEFAULT_RETRY_POLICY, retryOn: [] },
      checkpoint: 'after',
      idempotencyKey: `pitr-config:${ctx.configDigest}`,
    },
    {
      stepId: 'write-recovery-signal',
      kind: 'write-file',
      dependsOn: ['write-recovery-config'],
      file: { path: `${request.dataDirectory}/recovery.signal`, content: '', mode: 0o600 },
      preconditions: [],
      postconditions: [],
      retry: { ...DEFAULT_RETRY_POLICY, retryOn: [] },
      checkpoint: 'after',
      idempotencyKey: `pitr-signal:${ctx.configDigest}`,
    },
    {
      stepId: 'start-instance',
      kind: 'exec',
      dependsOn: ['write-recovery-signal'],
      argv: [
        'pg_ctl',
        '-D',
        request.dataDirectory,
        '-l',
        request.logPath,
        '-w',
        '-t',
        '180',
        '-o',
        `-p ${request.port}`,
        'start',
      ],
      preconditions: [],
      postconditions: [],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `pitr-start:${ctx.configDigest}`,
      timeoutMs: 240_000,
    },
    {
      stepId: 'assert-recovery-target',
      kind: 'exec',
      dependsOn: ['start-instance'],
      argv: [...psql, pitrTargetAssertionSql(target)],
      preconditions: [],
      postconditions: [],
      retry: { ...waitForTargetRetry },
      checkpoint: 'after',
      idempotencyKey: `pitr-target:${ctx.configDigest}`,
      timeoutMs: 120_000,
    },
  ]

  const verifyData = (dependsOn: string): Step => ({
    stepId: 'verify-data',
    kind: 'exec',
    dependsOn: [dependsOn],
    argv: [...psql, request.verifySql as string],
    preconditions: [],
    postconditions: [],
    retry: DEFAULT_RETRY_POLICY,
    checkpoint: 'after',
    idempotencyKey: `pitr-verify:${ctx.configDigest}`,
  })

  if (action === 'promote') {
    steps.push(
      {
        stepId: 'promote-instance',
        kind: 'exec',
        dependsOn: ['assert-recovery-target'],
        argv: ['pg_ctl', '-D', request.dataDirectory, 'promote', '-w', '-t', '60'],
        preconditions: [],
        postconditions: [],
        retry: DEFAULT_RETRY_POLICY,
        checkpoint: 'after',
        idempotencyKey: `pitr-promote:${ctx.configDigest}`,
        timeoutMs: 90_000,
      },
      {
        stepId: 'assert-promoted',
        kind: 'exec',
        dependsOn: ['promote-instance'],
        argv: [...psql, pitrPromotedAssertionSql(target)],
        preconditions: [],
        postconditions: [],
        retry: { ...waitForTargetRetry },
        checkpoint: 'after',
        idempotencyKey: `pitr-promoted:${ctx.configDigest}`,
      },
    )
    if (request.verifySql !== undefined) steps.push(verifyData('assert-promoted'))
  } else if (action === 'pause') {
    if (request.verifySql !== undefined) steps.push(verifyData('assert-recovery-target'))
  } else {
    if (request.verifySql !== undefined) steps.push(verifyData('assert-recovery-target'))
    steps.push({
      stepId: 'stop-instance',
      kind: 'exec',
      dependsOn: [request.verifySql === undefined ? 'assert-recovery-target' : 'verify-data'],
      argv: [
        'pg_ctl',
        '-D',
        request.dataDirectory,
        'stop',
        '-m',
        'fast',
        '-w',
        '-t',
        '60',
      ],
      preconditions: [],
      postconditions: [
        { kind: 'pathAbsent', path: `${request.dataDirectory}/postmaster.pid` },
      ],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `pitr-stop:${ctx.configDigest}`,
      timeoutMs: 90_000,
    })
  }

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'native-physical',
    targetId: asTargetId(`pitr:${request.dataDirectory}`),
    fingerprint: fingerprintFor(request.connection, ctx),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    risk: 'destructive',
  }
}
