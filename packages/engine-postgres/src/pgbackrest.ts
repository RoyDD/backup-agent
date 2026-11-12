import {
  asPlanId,
  asTargetId,
  DEFAULT_RETRY_POLICY,
  newId,
  preflightProvider,
  ProviderOperationError,
  type Capability,
  type CatalogEntry,
  type ConnectionParams,
  type Executor,
  type InstanceInfo,
  type Plan,
  type PlanBuildContext,
  type PlanOperation,
  type PlanRequestOf,
  type ProviderAdapter,
  type ProviderCatalog,
  type ProviderDescriptor,
  type ProviderPreflight,
  type ProviderRequests,
  type Step,
} from '@backup-agent/core'

import { POSTGRES_ENGINE_DESCRIPTOR, PSQL_TOOL } from './descriptor'
import { fingerprintFromInstance } from './logical'
import { probePostgres } from './probe'

/**
 * pgBackRest works on physical files and owns its repository, so every Plan it
 * builds needs the provider's `physical` capability.
 */
const PHYSICAL_CAPABILITIES: readonly Capability[] = ['physical']

export const PGBACKREST_PROVIDER_ID = 'pgbackrest'

export interface PgBackRestBase {
  configPath: string
  stanza: string
  repo?: string
}

export function buildPgBackRestArgv(
  base: PgBackRestBase,
  command: string,
  args: readonly string[] = [],
): string[] {
  return [
    'pgbackrest',
    `--config=${base.configPath}`,
    `--stanza=${base.stanza}`,
    ...(base.repo === undefined ? [] : [`--repo=${base.repo}`]),
    command,
    ...args,
  ]
}

export interface PgBackRestBackupRequest extends PgBackRestBase {
  type?: 'full' | 'diff' | 'incr'
  ensureStanza?: boolean
}

/**
 * pgBackRest owns its repository. This plan only orchestrates documented
 * commands (`stanza-create`, `check`, `backup`, `verify`); it never touches
 * repository files directly.
 */
export function buildPgBackRestBackupPlan(
  request: PgBackRestBackupRequest,
  ctx: PlanBuildContext,
): Plan {
  const steps: Step[] = []

  if (request.ensureStanza === true) {
    steps.push({
      stepId: 'stanza-create',
      kind: 'exec',
      dependsOn: [],
      argv: buildPgBackRestArgv(request, 'stanza-create'),
      preconditions: [],
      postconditions: [],
      retry: { ...DEFAULT_RETRY_POLICY, retryOn: [] },
      checkpoint: 'after',
      idempotencyKey: `pgbr-stanza:${ctx.configDigest}`,
      timeoutMs: 300_000,
    })
  }

  steps.push({
    stepId: 'check',
    kind: 'exec',
    dependsOn: request.ensureStanza === true ? ['stanza-create'] : [],
    argv: buildPgBackRestArgv(request, 'check'),
    preconditions: [],
    postconditions: [],
    retry: { ...DEFAULT_RETRY_POLICY, retryOn: ['transient'] },
    checkpoint: 'after',
    idempotencyKey: `pgbr-check:${ctx.configDigest}`,
    timeoutMs: 300_000,
  })

  steps.push({
    stepId: 'backup',
    kind: 'exec',
    dependsOn: ['check'],
    argv: buildPgBackRestArgv(request, 'backup', [
      `--type=${request.type ?? 'full'}`,
    ]),
    preconditions: [],
    postconditions: [],
    retry: DEFAULT_RETRY_POLICY,
    checkpoint: 'after',
    idempotencyKey: `pgbr-backup:${ctx.configDigest}`,
    timeoutMs: 21_600_000,
  })

  steps.push({
    stepId: 'verify',
    kind: 'exec',
    dependsOn: ['backup'],
    argv: buildPgBackRestArgv(request, 'verify'),
    preconditions: [],
    postconditions: [],
    retry: { ...DEFAULT_RETRY_POLICY, retryOn: ['transient'] },
    checkpoint: 'after',
    idempotencyKey: `pgbr-verify:${ctx.configDigest}`,
    timeoutMs: 7_200_000,
  })

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'pgbackrest',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(`pgbackrest:${request.stanza}`),
    fingerprint: fingerprintFromInstance(ctx, `pgbackrest:${request.stanza}`),
    steps,
    // pgBackRest writes into its own repository on the database host; the
    // control plane cannot measure that, so no local byte estimate is claimed.
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: PHYSICAL_CAPABILITIES },
    risk: 'read-only',
  }
}

export interface PgBackRestTarget {
  type: 'time' | 'lsn' | 'xid' | 'name' | 'immediate'
  value?: string
}

export interface PgBackRestRestoreRequest extends PgBackRestBase {
  dataDirectory: string
  target?: PgBackRestTarget
  action?: 'promote' | 'pause' | 'shutdown'
  delta?: boolean
  startPort?: string
  logPath?: string
}

export function buildPgBackRestRestoreArgv(request: PgBackRestRestoreRequest): string[] {
  const args = [`--pg1-path=${request.dataDirectory}`]
  if (request.delta === true) args.push('--delta')
  if (request.target !== undefined) {
    args.push(`--type=${request.target.type}`)
    if (request.target.value !== undefined) args.push(`--target=${request.target.value}`)
    args.push(`--target-action=${request.action ?? 'promote'}`)
  }
  return buildPgBackRestArgv(request, 'restore', args)
}

export function buildPgBackRestRestorePlan(
  request: PgBackRestRestoreRequest,
  ctx: PlanBuildContext,
): Plan {
  const steps: Step[] = [
    {
      stepId: 'restore',
      kind: 'exec',
      dependsOn: [],
      argv: buildPgBackRestRestoreArgv(request),
      preconditions: [],
      postconditions: [],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `pgbr-restore:${ctx.configDigest}`,
      timeoutMs: 21_600_000,
    },
  ]

  if (request.startPort !== undefined) {
    steps.push({
      stepId: 'start-instance',
      kind: 'exec',
      dependsOn: ['restore'],
      argv: [
        'pg_ctl',
        '-D',
        request.dataDirectory,
        '-l',
        request.logPath ?? `${request.dataDirectory}.log`,
        '-w',
        '-t',
        '180',
        '-o',
        `-p ${request.startPort}`,
        'start',
      ],
      preconditions: [],
      postconditions: [],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `pgbr-start:${ctx.configDigest}`,
      timeoutMs: 240_000,
    })
  }

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'pgbackrest',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(`pgbackrest:${request.stanza}`),
    fingerprint: fingerprintFromInstance(ctx, `pgbackrest:${request.stanza}`),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: PHYSICAL_CAPABILITIES },
    risk: 'destructive',
  }
}

export interface PgBackRestExpireRequest extends PgBackRestBase {
  repo?: string
}

/** Repository pruning is delegated to pgBackRest's own `expire`. */
export function buildPgBackRestExpirePlan(
  request: PgBackRestExpireRequest,
  ctx: PlanBuildContext,
): Plan {
  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'pgbackrest',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(`pgbackrest:${request.stanza}`),
    fingerprint: fingerprintFromInstance(ctx, `pgbackrest:${request.stanza}`),
    steps: [
      {
        stepId: 'expire',
        kind: 'exec',
        dependsOn: [],
        argv: buildPgBackRestArgv(request, 'expire'),
        preconditions: [],
        postconditions: [],
        retry: DEFAULT_RETRY_POLICY,
        checkpoint: 'after',
        idempotencyKey: `pgbr-expire:${ctx.configDigest}`,
        timeoutMs: 3_600_000,
      },
    ],
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: PHYSICAL_CAPABILITIES },
    risk: 'destructive',
  }
}

export interface PgBackRestVerifyRequest {
  config: string
  stanza: string
}

/** Verification reads the repository and needs the engine's verify support. */
const VERIFY_CAPABILITIES: readonly Capability[] = ['physical', 'verify-restore']

/**
 * `pgbackrest verify` validates the repository against the manifests it wrote.
 * It mutates nothing, but it does read every file, so the risk is `reversible`
 * rather than `read-only`: the step still needs an approval at that level.
 */
export function buildPgBackRestVerifyPlan(
  request: PgBackRestVerifyRequest,
  ctx: PlanBuildContext,
): Plan {
  const target = `pgbackrest:${request.stanza}`
  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: PGBACKREST_PROVIDER_ID,
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(target),
    fingerprint: fingerprintFromInstance(ctx, target),
    steps: [
      {
        stepId: 'verify',
        kind: 'exec',
        dependsOn: [],
        argv: [
          'pgbackrest',
          'verify',
          `--config=${request.config}`,
          `--stanza=${request.stanza}`,
        ],
        preconditions: [],
        postconditions: [],
        retry: { ...DEFAULT_RETRY_POLICY, retryOn: ['transient'] },
        checkpoint: 'after',
        idempotencyKey: `pgbr-verify:${ctx.configDigest}`,
        timeoutMs: 7_200_000,
      },
    ],
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: VERIFY_CAPABILITIES },
    risk: 'reversible',
  }
}

export interface PgBackRestCatalogRequest {
  config: string
  stanza?: string
}

/** `pgbackrest info --output=json` is the provider's machine-readable catalog. */
export function buildPgBackRestInfoArgv(request: PgBackRestCatalogRequest): string[] {
  return [
    'pgbackrest',
    'info',
    '--output=json',
    `--config=${request.config}`,
    ...(request.stanza === undefined ? [] : [`--stanza=${request.stanza}`]),
  ]
}

/** Placeholder that replaces a `--config` path before it can reach an error. */
const CONFIG_REDACTION = '<config>'

function redactConfig(text: string, configs: readonly string[]): string {
  let output = text
  for (const config of configs) {
    if (config === '') continue
    output = output.split(config).join(CONFIG_REDACTION)
  }
  return output
}

function catalogText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * pgBackRest reports `timestamp.start`/`timestamp.stop` as epoch seconds in
 * `info --output=json`; fixtures and older builds use ISO strings. Both are
 * normalised to an ISO string so callers compare instants, not formats.
 */
function catalogTimestamp(value: unknown): string | null {
  if (typeof value === 'string') return catalogText(value)
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  // Epoch milliseconds are > 1e11 for any date after 1973; epoch seconds are not.
  const milliseconds = value > 1e11 ? value : value * 1_000
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function catalogBytes(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function startedAtMs(entry: CatalogEntry): number | null {
  if (entry.startedAt === null) return null
  const parsed = Date.parse(entry.startedAt)
  return Number.isFinite(parsed) ? parsed : null
}

/** Newest `startedAt` first; entries the provider did not date go last. */
function sortNewestFirst(entries: readonly CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((left, right) => {
    const leftMs = startedAtMs(left)
    const rightMs = startedAtMs(right)
    if (leftMs === null && rightMs === null) return 0
    if (leftMs === null) return 1
    if (rightMs === null) return -1
    return rightMs - leftMs
  })
}

/**
 * Maps `pgbackrest info --output=json` into catalog entries. A partially shaped
 * entry degrades to `null` fields instead of throwing: the catalog is advisory,
 * so one odd stanza must not hide the backups the operator asked about.
 */
export function catalogEntriesFromPgBackRestInfo(payload: unknown): CatalogEntry[] {
  if (!Array.isArray(payload)) {
    throw new ProviderOperationError(
      'INVALID_REQUEST',
      'pgbackrest info returned JSON that is not an array of stanzas',
    )
  }

  const entries: CatalogEntry[] = []
  payload.forEach((rawStanza, stanzaIndex) => {
    const stanza = asRecord(rawStanza)
    if (stanza === null) return
    const stanzaName = catalogText(stanza.name) ?? `stanza#${stanzaIndex}`
    if (!Array.isArray(stanza.backup)) return
    stanza.backup.forEach((rawBackup, backupIndex) => {
      const backup = asRecord(rawBackup)
      if (backup === null) return
      const timestamp = asRecord(backup.timestamp)
      const info = asRecord(backup.info)
      entries.push({
        label: catalogText(backup.label) ?? `${stanzaName}#${backupIndex}`,
        kind: catalogText(backup.type),
        startedAt: catalogTimestamp(timestamp?.start),
        stoppedAt: catalogTimestamp(timestamp?.stop),
        bytes: catalogBytes(info?.size),
      })
    })
  })

  return sortNewestFirst(entries)
}

export interface PgBackRestProviderRequests extends ProviderRequests {
  backup: PgBackRestBackupRequest
  restore: PgBackRestRestoreRequest
  verify: PgBackRestVerifyRequest
  prune: PgBackRestExpireRequest
  catalog: PgBackRestCatalogRequest
}

/**
 * Provider-level descriptor from plan §11. pgBackRest owns its repository, so
 * the control plane never deletes objects (ADR-003); retention is expressed as
 * `pgbackrest expire` and nothing else.
 */
export const pgbackrestDescriptor: ProviderDescriptor = {
  id: PGBACKREST_PROVIDER_ID,
  engineId: POSTGRES_ENGINE_DESCRIPTOR.id,
  capabilities: new Set<Capability>([
    'physical',
    'incremental',
    'wal-archive',
    'verify-restore',
  ]),
  ownership: 'provider-owned',
  versionRange: { min: '14', max: '17' },
  tools: [PSQL_TOOL, { name: 'pgbackrest', minVersion: '2.45', probe: 'version' }],
}

async function readPgBackRestCatalog(
  executor: Executor,
  request: PgBackRestCatalogRequest,
): Promise<ProviderCatalog> {
  const result = await executor.run(buildPgBackRestInfoArgv(request))
  if (result.exitCode !== 0) {
    // The failing argv carries `--config=<path>`; a path can name a host layout,
    // so stderr is redacted before it becomes an error message.
    const detail = redactConfig(result.stderr.trim().split('\n')[0] ?? '', [request.config])
    throw new ProviderOperationError(
      'INVALID_REQUEST',
      `pgbackrest info exited ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`,
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    throw new ProviderOperationError(
      'INVALID_REQUEST',
      'pgbackrest info did not return parsable JSON',
    )
  }

  return { providerId: PGBACKREST_PROVIDER_ID, entries: catalogEntriesFromPgBackRestInfo(payload) }
}

function planPgBackRest(
  operation: PlanOperation,
  request: PlanRequestOf<PgBackRestProviderRequests>,
  context: PlanBuildContext,
): Plan {
  // The request union is erased for generic callers; `operation` selects the
  // alternative, and each branch re-states its own request type.
  switch (operation) {
    case 'backup':
      return buildPgBackRestBackupPlan(request as PgBackRestBackupRequest, context)
    case 'restore':
      return buildPgBackRestRestorePlan(request as PgBackRestRestoreRequest, context)
    case 'verify':
      return buildPgBackRestVerifyPlan(request as PgBackRestVerifyRequest, context)
    case 'prune':
      return buildPgBackRestExpirePlan(request as PgBackRestExpireRequest, context)
    default: {
      const exhaustive: never = operation
      throw new ProviderOperationError(
        'INVALID_REQUEST',
        `unknown plan operation "${String(exhaustive)}"`,
      )
    }
  }
}

/**
 * §11 adapter for pgBackRest. Every verb delegates to the existing pure plan
 * builder, so dispatch and direct calls cannot drift; the one command the
 * builders did not expose as a verb is `pgbackrest verify`.
 */
export const pgbackrestProvider: ProviderAdapter<PgBackRestProviderRequests> = {
  descriptor: pgbackrestDescriptor,
  inspect(executor: Executor, connection: ConnectionParams): Promise<InstanceInfo> {
    return probePostgres(executor, connection)
  },
  preflight(
    executor: Executor,
    _request: PlanRequestOf<PgBackRestProviderRequests>,
    context: PlanBuildContext,
  ): Promise<ProviderPreflight> {
    return preflightProvider({
      executor,
      descriptor: pgbackrestDescriptor,
      engine: POSTGRES_ENGINE_DESCRIPTOR,
      instance: context.instance,
    })
  },
  plan: planPgBackRest,
  backup: buildPgBackRestBackupPlan,
  restore: buildPgBackRestRestorePlan,
  verify: buildPgBackRestVerifyPlan,
  prune: buildPgBackRestExpirePlan,
  catalog: readPgBackRestCatalog,
}
