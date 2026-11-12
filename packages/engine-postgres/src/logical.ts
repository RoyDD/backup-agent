import { createHash } from 'node:crypto'

import {
  asPlanId,
  asTargetId,
  canonicalJson,
  DEFAULT_RETRY_POLICY,
  newId,
  preflightProvider,
  ProviderOperationError,
  unsupportedOperation,
  type ConnectionParams,
  type Capability,
  type LogicalBackupRequest,
  type LogicalFormat,
  type LogicalRestoreRequest,
  type Plan,
  type PlanBuildContext,
  type PlanFingerprint,
  type ProviderAdapter,
  type ProviderDescriptor,
  type Step,
} from '@backup-agent/core'

import { POSTGRES_ENGINE_DESCRIPTOR, PSQL_TOOL } from './descriptor'
import { probePostgres } from './probe'

/** Capabilities every native logical Plan needs from its provider. */
const LOGICAL_CAPABILITIES: readonly Capability[] = ['logical']

/** A dump verification reads the artifact and reports its TOC; no writes. */
const VERIFY_CAPABILITIES: readonly Capability[] = ['logical', 'verify-restore']

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
  return fingerprintFromInstance(ctx, `${connection.host}:${connection.port}/${connection.database}`)
}

/** Fingerprint from inspected facts, for providers that do not use a DSN. */
export function fingerprintFromInstance(
  ctx: PlanBuildContext,
  fallbackTarget: string,
): PlanFingerprint {
  return {
    systemIdentifier: ctx.instance.systemIdentifier ?? `unavailable:${fallbackTarget}`,
    configDigest: ctx.configDigest,
    targetOid: ctx.instance.databaseOid ?? `target:${fallbackTarget}`,
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
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(targetIdFor(request.connection, request.database)),
    fingerprint: fingerprintFor(request.connection, ctx),
    steps,
    resources: {
      estimatedBytes: ctx.instance.dataBytes ?? 0,
      estimatedDurationMs: 0,
      concurrencySlots: 1,
    },
    // The dump lands on the control plane's filesystem, so the instance's total
    // data size bounds the local write it needs.
    requires: { capabilities: LOGICAL_CAPABILITIES },
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

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'native-logical',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(targetIdFor(request.connection, request.database)),
    fingerprint: fingerprintFor(request.connection, ctx),
    steps,
    // The restore input is read on the database host; nothing is written locally.
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: LOGICAL_CAPABILITIES },
    // Every restore writes into a database and can execute destructive SQL
    // from its input (e.g. pg_dump --clean or pg_dumpall). CLI flags alone do
    // not prove that the input is non-destructive or that the target is empty.
    risk: 'destructive',
  }
}

export interface LogicalVerifyRequest {
  connection: ConnectionParams
  inputPath: string
  format: LogicalFormat
  /** Accepted for parity with restore; listing a TOC never maps owners. */
  noOwner?: boolean
}

/**
 * Verifies a dump artifact by listing its table of contents. `pg_restore
 * --list` reads the archive header and TOC only: it opens no connection and
 * writes nothing, so the plan is `reversible` rather than `read-only` solely
 * because it does not prove the dump is restorable.
 *
 * A plain SQL script has no archive header to list. Refusing it is a typed
 * `INVALID_REQUEST`: replaying it into a scratch database would be a restore,
 * not a verification, and must not be smuggled into a plan named "verify".
 */
export function buildLogicalVerifyPlan(
  request: LogicalVerifyRequest,
  ctx: PlanBuildContext,
): Plan {
  if (request.format === 'plain') {
    throw new ProviderOperationError(
      'INVALID_REQUEST',
      'plain-format dumps have no table of contents to verify; take the dump with "custom" or "directory" format',
    )
  }

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'native-logical',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(`verify:${targetIdFor(request.connection, request.connection.database)}`),
    fingerprint: fingerprintFor(request.connection, ctx),
    steps: [
      {
        stepId: 'verify-dump',
        kind: 'exec',
        dependsOn: [],
        // No `--no-owner`: listing a TOC emits owner names as data and never
        // applies them, so the flag would change nothing the artifact shows.
        argv: ['pg_restore', '--list', request.inputPath],
        preconditions: [],
        postconditions: [],
        retry: DEFAULT_RETRY_POLICY,
        checkpoint: 'after',
        idempotencyKey: `logical-verify-dump:${ctx.configDigest}`,
      },
    ],
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: VERIFY_CAPABILITIES },
    risk: 'reversible',
  }
}

/** §11 provider requests for the native logical adapter. */
export interface LogicalProviderRequests {
  backup: LogicalBackupRequest
  restore: LogicalRestoreRequest
  verify: LogicalVerifyRequest
  prune: unknown
  catalog: unknown
}

export const LOGICAL_PROVIDER_DESCRIPTOR: ProviderDescriptor = {
  id: 'native-logical',
  engineId: POSTGRES_ENGINE_DESCRIPTOR.id,
  capabilities: new Set(['logical', 'verify-restore']),
  // Dumps land on the control plane's filesystem, which the control plane owns.
  ownership: 'managed',
  versionRange: { min: '14', max: '17' },
  tools: [
    PSQL_TOOL,
    { name: 'pg_dump', minVersion: '14', probe: 'version' },
    { name: 'pg_restore', minVersion: '14', probe: 'version' },
  ],
}

/**
 * The §11 adapter for `pg_dump`/`pg_restore`. It carries no argv of its own: the
 * builders above are the single source of step truth, and `plan()` exists only
 * to dispatch to them.
 *
 * `prune` and `catalog` are typed refusals rather than no-ops: a dump repository
 * has no provider-owned object index, so retention is the operator's filesystem
 * policy and must not be invented here.
 */
export const logicalProvider: ProviderAdapter<LogicalProviderRequests> = {
  descriptor: LOGICAL_PROVIDER_DESCRIPTOR,

  inspect(executor, connection) {
    return probePostgres(executor, connection)
  },

  preflight(executor, _request, context) {
    return preflightProvider({
      executor,
      descriptor: LOGICAL_PROVIDER_DESCRIPTOR,
      engine: POSTGRES_ENGINE_DESCRIPTOR,
      instance: context.instance,
    })
  },

  plan(operation, request, context) {
    switch (operation) {
      case 'backup':
        return buildLogicalBackupPlan(request as LogicalBackupRequest, context)
      case 'restore':
        return buildLogicalRestorePlan(request as LogicalRestoreRequest, context)
      case 'verify':
        return buildLogicalVerifyPlan(request as LogicalVerifyRequest, context)
      case 'prune':
        return unsupportedOperation('prune', LOGICAL_PROVIDER_DESCRIPTOR.id)
      default: {
        const exhaustive: never = operation
        throw new Error(`unhandled operation: ${String(exhaustive)}`)
      }
    }
  },

  backup(request, context) {
    return buildLogicalBackupPlan(request, context)
  },

  restore(request, context) {
    return buildLogicalRestorePlan(request, context)
  },

  verify(request, context) {
    return buildLogicalVerifyPlan(request, context)
  },

  prune() {
    return unsupportedOperation('prune', LOGICAL_PROVIDER_DESCRIPTOR.id)
  },

  catalog(): never {
    return unsupportedOperation('catalog', LOGICAL_PROVIDER_DESCRIPTOR.id)
  },
}
