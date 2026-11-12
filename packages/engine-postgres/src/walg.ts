import {
  asPlanId,
  asTargetId,
  DEFAULT_RETRY_POLICY,
  newId,
  preflightProvider,
  unsupportedOperation,
  type Capability,
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
 * WAL-G pushes and fetches physical files and owns its repository; every Plan it
 * builds needs the provider's `physical` capability.
 */
const PHYSICAL_CAPABILITIES: readonly Capability[] = ['physical']

export interface WalGBase {
  /** Binary name or absolute path; defaults to `wal-g`. */
  command?: string
}

export function buildWalGArgv(base: WalGBase, args: readonly string[]): string[] {
  return [base.command ?? 'wal-g', ...args]
}

export interface WalGBackupRequest extends WalGBase {
  dataDirectory: string
}

/** `wal-g backup-push` uploads a physical backup to the configured repository. */
export function buildWalGBackupPlan(request: WalGBackupRequest, ctx: PlanBuildContext): Plan {
  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'walg',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(`walg:${request.dataDirectory}`),
    fingerprint: fingerprintFromInstance(ctx, `walg:${request.dataDirectory}`),
    steps: [
      {
        stepId: 'backup-push',
        kind: 'exec',
        dependsOn: [],
        argv: buildWalGArgv(request, ['backup-push', request.dataDirectory]),
        preconditions: [],
        postconditions: [],
        retry: DEFAULT_RETRY_POLICY,
        checkpoint: 'after',
        idempotencyKey: `walg-backup:${ctx.configDigest}`,
        timeoutMs: 21_600_000,
      },
    ],
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: PHYSICAL_CAPABILITIES },
    risk: 'read-only',
  }
}

export interface WalGRestoreRequest extends WalGBase {
  dataDirectory: string
  backupName?: string
  startPort?: string
  logPath?: string
}

/** `wal-g backup-fetch` restores into an empty data directory. */
export function buildWalGRestorePlan(request: WalGRestoreRequest, ctx: PlanBuildContext): Plan {
  const steps: Step[] = [
    {
      stepId: 'backup-fetch',
      kind: 'exec',
      dependsOn: [],
      argv: buildWalGArgv(request, [
        'backup-fetch',
        request.dataDirectory,
        request.backupName ?? 'LATEST',
      ]),
      preconditions: [{ kind: 'pathAbsent', path: request.dataDirectory }],
      postconditions: [],
      retry: DEFAULT_RETRY_POLICY,
      checkpoint: 'after',
      idempotencyKey: `walg-restore:${ctx.configDigest}`,
      timeoutMs: 21_600_000,
    },
  ]

  if (request.startPort !== undefined) {
    steps.push({
      stepId: 'start-instance',
      kind: 'exec',
      dependsOn: ['backup-fetch'],
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
      idempotencyKey: `walg-start:${ctx.configDigest}`,
      timeoutMs: 240_000,
    })
  }

  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'walg',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId(`walg:${request.dataDirectory}`),
    fingerprint: fingerprintFromInstance(ctx, `walg:${request.dataDirectory}`),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: PHYSICAL_CAPABILITIES },
    risk: 'destructive',
  }
}

export interface WalGPruneRequest extends WalGBase {
  retainFull: number
}

/** Retention is delegated to WAL-G; it owns its repository. */
export function buildWalGPrunePlan(request: WalGPruneRequest, ctx: PlanBuildContext): Plan {
  return {
    planId: asPlanId(newId('pln')),
    ticketId: ctx.ticketId,
    mandateId: ctx.mandateId,
    engine: 'postgres',
    provider: 'walg',
    ...(ctx.transport === undefined ? {} : { transport: ctx.transport }),
    targetId: asTargetId('walg:repository'),
    fingerprint: fingerprintFromInstance(ctx, 'walg:repository'),
    steps: [
      {
        stepId: 'delete-retain',
        kind: 'exec',
        dependsOn: [],
        argv: buildWalGArgv(request, [
          'delete',
          'retain',
          'FULL',
          String(request.retainFull),
          '--confirm',
        ]),
        preconditions: [],
        postconditions: [],
        retry: { ...DEFAULT_RETRY_POLICY, retryOn: [] },
        checkpoint: 'after',
        idempotencyKey: `walg-prune:${ctx.configDigest}`,
        timeoutMs: 3_600_000,
      },
    ],
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
    requires: { capabilities: PHYSICAL_CAPABILITIES },
    risk: 'destructive',
  }
}

export interface WalGProviderRequests extends ProviderRequests {
  backup: WalGBackupRequest
  restore: WalGRestoreRequest
  /** WAL-G has no verify verb; asking for one is a typed refusal, not a no-op. */
  verify: unknown
  prune: WalGPruneRequest
  /** No machine-readable catalog command is wired yet, so this refuses too. */
  catalog: unknown
}

export const WALG_PROVIDER_ID = 'walg'

/**
 * Provider-level descriptor from plan §11. WAL-G owns its repository, so the
 * control plane never deletes objects (ADR-003); retention is expressed as
 * `wal-g delete retain` and nothing else.
 *
 * `incremental` is deliberately absent: `wal-g backup-push` always uploads a
 * full backup, so claiming the capability would be a silent downgrade.
 */
export const walgDescriptor: ProviderDescriptor = {
  id: WALG_PROVIDER_ID,
  engineId: POSTGRES_ENGINE_DESCRIPTOR.id,
  capabilities: new Set<Capability>(['physical', 'wal-archive']),
  ownership: 'provider-owned',
  versionRange: { min: '14', max: '17' },
  tools: [PSQL_TOOL, { name: 'wal-g', minVersion: '2.0', probe: 'version' }],
}

/** WAL-G has no `verify` subcommand; fail closed instead of approximating one. */
function refuseVerify(): Plan {
  return unsupportedOperation('verify', WALG_PROVIDER_ID)
}

/** No machine-readable catalog command is wired; fail closed. */
async function refuseCatalog(): Promise<ProviderCatalog> {
  return unsupportedOperation('catalog', WALG_PROVIDER_ID)
}

function planWalG(
  operation: PlanOperation,
  request: PlanRequestOf<WalGProviderRequests>,
  context: PlanBuildContext,
): Plan {
  // The request union collapses to `unknown` because `verify`/`catalog` are
  // unsupported; `operation` selects the alternative, and each branch re-states
  // the request type it expects.
  switch (operation) {
    case 'backup':
      return buildWalGBackupPlan(request as WalGBackupRequest, context)
    case 'restore':
      return buildWalGRestorePlan(request as WalGRestoreRequest, context)
    case 'verify':
      return refuseVerify()
    case 'prune':
      return buildWalGPrunePlan(request as WalGPruneRequest, context)
    default: {
      const exhaustive: never = operation
      return unsupportedOperation(exhaustive, WALG_PROVIDER_ID)
    }
  }
}

/**
 * §11 adapter for WAL-G. The plan verbs delegate to the existing pure builders;
 * `verify` and `catalog` refuse with a typed `UNSUPPORTED_OPERATION` because
 * WAL-G exposes neither, and a silent approximation would defeat capability
 * negotiation.
 */
export const walgProvider: ProviderAdapter<WalGProviderRequests> = {
  descriptor: walgDescriptor,
  inspect(executor: Executor, connection: ConnectionParams): Promise<InstanceInfo> {
    return probePostgres(executor, connection)
  },
  preflight(
    executor: Executor,
    _request: PlanRequestOf<WalGProviderRequests>,
    context: PlanBuildContext,
  ): Promise<ProviderPreflight> {
    return preflightProvider({
      executor,
      descriptor: walgDescriptor,
      engine: POSTGRES_ENGINE_DESCRIPTOR,
      instance: context.instance,
    })
  },
  plan: planWalG,
  backup: buildWalGBackupPlan,
  restore: buildWalGRestorePlan,
  verify: refuseVerify,
  prune: buildWalGPrunePlan,
  catalog: refuseCatalog,
}
