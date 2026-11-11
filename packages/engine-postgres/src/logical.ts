import { createHash } from 'node:crypto'

import {
  asPlanId,
  asTargetId,
  canonicalJson,
  DEFAULT_RETRY_POLICY,
  newId,
  type ConnectionParams,
  type LogicalBackupRequest,
  type LogicalRestoreRequest,
  type Plan,
  type PlanBuildContext,
  type PlanFingerprint,
  type Step,
} from '@backup-agent/core'

export function requestDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(redactSecrets(value))).digest('hex')
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'password') continue
      output[key] = redactSecrets(entry)
    }
    return output
  }
  return value
}

export function targetIdFor(connection: ConnectionParams, database: string): string {
  return `${connection.host}:${connection.port}/${database}`
}

export function fingerprintFor(
  connection: ConnectionParams,
  ctx: PlanBuildContext,
): PlanFingerprint {
  return {
    systemIdentifier:
      ctx.instance.systemIdentifier ?? `unavailable:${connection.host}:${connection.port}`,
    configDigest: ctx.configDigest,
    targetOid: ctx.instance.databaseOid ?? `db:${connection.database}`,
    createdAt: ctx.now,
    expiresAt: new Date(Date.parse(ctx.now) + 3_600_000).toISOString(),
  }
}

export function buildBackupArgv(request: LogicalBackupRequest): string[] {
  if (request.jobs !== undefined && request.format !== 'directory') {
    throw new Error('--jobs requires directory format')
  }
  const { connection } = request
  const argv = [
    'pg_dump',
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--username=${connection.user}`,
    `--dbname=${request.database}`,
    '--no-password',
    `--format=${request.format}`,
    `--file=${request.outputPath}`,
  ]
  if (request.jobs !== undefined) argv.push(`--jobs=${request.jobs}`)
  if (request.compression !== undefined) argv.push(`--compress=${request.compression}`)
  for (const table of request.tables ?? []) argv.push(`--table=${table}`)
  for (const schema of request.schemas ?? []) argv.push(`--schema=${schema}`)
  return argv
}

export function buildRestoreArgv(request: LogicalRestoreRequest): string[] {
  const { connection } = request
  if (request.format === 'plain') {
    return [
      'psql',
      `--host=${connection.host}`,
      `--port=${connection.port}`,
      `--username=${connection.user}`,
      `--dbname=${request.database}`,
      '--no-password',
      '--set=ON_ERROR_STOP=1',
      `--file=${request.inputPath}`,
    ]
  }

  if (request.jobs !== undefined && request.format !== 'directory') {
    throw new Error('--jobs requires directory format')
  }

  const argv = [
    'pg_restore',
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--username=${connection.user}`,
    `--dbname=${request.database}`,
    '--no-password',
  ]
  if (request.clean) {
    argv.push('--clean')
    if (request.ifExists) argv.push('--if-exists')
  }
  if (request.noOwner) argv.push('--no-owner')
  if (request.jobs !== undefined) argv.push(`--jobs=${request.jobs}`)
  argv.push(request.inputPath)
  return argv
}

export function buildCreateDatabaseArgv(connection: ConnectionParams, database: string): string[] {
  return [
    'createdb',
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--username=${connection.user}`,
    '--maintenance-db=postgres',
    `--owner=${connection.user}`,
    database,
  ]
}

export function buildLogicalBackupPlan(request: LogicalBackupRequest, ctx: PlanBuildContext): Plan {
  const steps: Step[] = [
    {
      stepId: 'dump',
      kind: 'exec',
      dependsOn: [],
      argv: buildBackupArgv(request),
      preconditions: [],
      postconditions: [{ kind: 'fileExists', path: request.outputPath }],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `logical-dump:${ctx.configDigest}`,
    },
  ]

  if (request.format !== 'plain') {
    steps.push({
      stepId: 'verify-artifact',
      kind: 'exec',
      dependsOn: ['dump'],
      argv: ['pg_restore', '--list', request.outputPath],
      preconditions: [{ kind: 'fileExists', path: request.outputPath }],
      postconditions: [],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `logical-verify:${ctx.configDigest}`,
    })
  }

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'native-logical',
    targetId: asTargetId(targetIdFor(request.connection, request.database)),
    fingerprint: fingerprintFor(request.connection, ctx),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    risk: 'read-only',
  }
}

export function buildLogicalRestorePlan(
  request: LogicalRestoreRequest,
  ctx: PlanBuildContext,
): Plan {
  const steps: Step[] = []

  if (request.createDatabase === true) {
    steps.push({
      stepId: 'create-database',
      kind: 'exec',
      dependsOn: [],
      argv: buildCreateDatabaseArgv(request.connection, request.database),
      preconditions: [],
      postconditions: [],
      retry: { ...DEFAULT_RETRY_POLICY, retryOn: [] },
      checkpoint: 'after',
      idempotencyKey: `logical-createdb:${ctx.configDigest}`,
    })
  }

  steps.push({
    stepId: 'restore',
    kind: 'exec',
    dependsOn: request.createDatabase === true ? ['create-database'] : [],
    argv: buildRestoreArgv(request),
    preconditions: [],
    postconditions: [],
    retry: DEFAULT_RETRY_POLICY,
    checkpoint: 'after',
    idempotencyKey: `logical-restore:${ctx.configDigest}`,
  })

  const destructive = request.clean === true || request.createDatabase === true

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'native-logical',
    targetId: asTargetId(targetIdFor(request.connection, request.database)),
    fingerprint: fingerprintFor(request.connection, ctx),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    risk: destructive ? 'destructive' : 'reversible',
  }
}
