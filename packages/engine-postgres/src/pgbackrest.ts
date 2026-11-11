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
    targetId: asTargetId(`pgbackrest:${request.stanza}`),
    fingerprint: fingerprintFromInstance(ctx, `pgbackrest:${request.stanza}`),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
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
    targetId: asTargetId(`pgbackrest:${request.stanza}`),
    fingerprint: fingerprintFromInstance(ctx, `pgbackrest:${request.stanza}`),
    steps,
    resources: { estimatedBytes: 0, estimatedDurationMs: 0, concurrencySlots: 1 },
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
    risk: 'destructive',
  }
}
