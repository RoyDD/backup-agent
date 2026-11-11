import {
  asPlanId,
  asTargetId,
  DEFAULT_RETRY_POLICY,
  newId,
  type Plan,
  type PlanBuildContext,
  type Step,
} from '@backup-agent/core'

import { fingerprintFromInstance } from './logical'

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
    targetId: asTargetId(`walg:${request.dataDirectory}`),
    fingerprint: fingerprintFromInstance(ctx, `walg:${request.dataDirectory}`),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
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
    risk: 'destructive',
  }
}
