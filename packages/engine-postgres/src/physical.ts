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

/**
 * Starts a promoted instance from an existing base backup. The caller is
 * responsible for taking the base backup and providing a working
 * restore_command. The data directory is modified in place.
 */
export function buildPitrRestorePlan(request: PitrRestoreRequest, ctx: PlanBuildContext): Plan {
  const existing = request.existingAutoConf ?? ''
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
  const autoConf = `${existing}${separator}${buildPitrConfig(request)}\n`

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
      stepId: 'assert-promoted',
      kind: 'exec',
      dependsOn: ['start-instance'],
      argv: [...psql, 'select 1 / (case when pg_is_in_recovery() then 0 else 1 end)'],
      preconditions: [],
      postconditions: [],
      retry: {
        maxAttempts: 20,
        initialDelayMs: 500,
        maxDelayMs: 30_000,
        backoff: 'exponential',
        retryOn: ['transient'],
      },
      checkpoint: 'after',
      idempotencyKey: `pitr-promoted:${ctx.configDigest}`,
    },
  ]

  if (request.verifySql !== undefined) {
    steps.push({
      stepId: 'verify-data',
      kind: 'exec',
      dependsOn: ['assert-promoted'],
      argv: [...psql, request.verifySql],
      preconditions: [],
      postconditions: [],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `pitr-verify:${ctx.configDigest}`,
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
