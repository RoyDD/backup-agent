import { afterEach, describe, expect, it } from 'vitest'

import {
  asAttemptId,
  asMandateId,
  asPlanId,
  asTargetId,
  asTicketId,
} from '../../src/domain/ids'
import type { AssetDescriptor } from '../../src/domain/asset'
import type { Plan, Step } from '../../src/domain/plan'
import type { RunPlanResult } from '../../src/runner/run-plan'
import { dispatchOutbox } from '../../src/persistence/outbox-dispatch'
import {
  OUTBOX_TOPIC_RUN_AUDIT,
  OUTBOX_TOPIC_RUN_FAILURE,
  finishRun,
  finishRunInTransaction,
  startRun,
  startRunInTransaction,
  type StartRunOutcome,
} from '../../src/persistence/run-lifecycle'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { ApprovalRecord, LeaseRecord, Repository } from '../../src/ports/repository'
import {
  DestructiveAuthorizationDeniedError,
  type DestructiveAuthorizationInput,
} from '../../src/security/destructive-authorization'

const T0 = '2026-01-01T00:00:00.000Z'
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()
const target = asTargetId('pg-prod')

let repo: Repository | undefined

afterEach(async () => {
  await repo?.close()
  repo = undefined
})

async function open(): Promise<Repository> {
  const created = await createSqliteRepository({ filename: ':memory:' })
  await created.migrate()
  repo = created
  return created
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const step: Step = {
    stepId: 'dump',
    kind: 'exec',
    dependsOn: [],
    argv: ['pg_dump', '-Fc'],
    preconditions: [],
    postconditions: [],
    retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoff: 'none', retryOn: [] },
    checkpoint: 'none',
    idempotencyKey: 'dump-1',
  }
  return {
    planId: asPlanId('pln_1'),
    ticketId: asTicketId('tkt_cli'),
    mandateId: asMandateId('mnd_cli'),
    engine: 'postgres',
    provider: 'native-logical',
    targetId: target,
    fingerprint: {
      systemIdentifier: 'sys-1',
      configDigest: 'cfg-1',
      targetOid: 'oid-1',
      createdAt: T0,
      expiresAt: at(3_600_000),
    },
    steps: [step],
    resources: { estimatedBytes: 1, estimatedDurationMs: 1, concurrencySlots: 1 },
    risk: 'reversible',
    ...overrides,
  }
}

async function beginRun(
  r: Repository,
  plan: Plan,
  attemptId = asAttemptId('att_1'),
): Promise<{ lease: LeaseRecord; attemptId: ReturnType<typeof asAttemptId> }> {
  return r.transaction(async (tx) => {
    const lease = await tx.leases.acquire({
      targetId: plan.targetId,
      owner: 'worker-1',
      now: T0,
      ttlMs: 60_000,
    })
    if (lease === null) throw new Error('lease denied in fixture')
    const started = await startRunInTransaction(tx, {
      plan,
      principalId: 'os:roy',
      lease,
      attemptId,
      now: T0,
    })
    if (!started.started) throw new Error(started.reason)
    return { lease, attemptId }
  })
}

function makeAsset(overrides: Partial<AssetDescriptor> = {}): AssetDescriptor {
  return {
    targetId: target,
    engine: 'postgres',
    environment: 'staging',
    owner: 'team-data',
    criticality: 'high',
    dataClassification: 'internal',
    rpoMinutes: 15,
    rtoMinutes: 120,
    protected: false,
    ...overrides,
  }
}

function makeApproval(
  approver: string,
  decision: 'approve' | 'reject',
  createdAt = T0,
): ApprovalRecord {
  return {
    id: `apr_${approver}_${decision}_${createdAt}`,
    targetId: target,
    configDigest: 'cfg-1',
    approver,
    decision,
    reason: null,
    createdAt,
  }
}

const AUTHORIZATION: DestructiveAuthorizationInput = {
  confirmed: true,
  requester: 'os:roy',
  osPrincipal: 'os:roy',
}

/** Starts a leased run the way the CLI does, but through the `startRun` wrapper. */
async function startLeased(
  r: Repository,
  plan: Plan,
  authorization?: DestructiveAuthorizationInput,
): Promise<StartRunOutcome> {
  const lease = await r.transaction((tx) =>
    tx.leases.acquire({ targetId: plan.targetId, owner: 'worker-1', now: T0, ttlMs: 60_000 }),
  )
  if (lease === null) throw new Error('lease denied in fixture')
  return startRun(r, {
    plan,
    principalId: 'os:roy',
    lease,
    attemptId: asAttemptId('att_race'),
    now: at(10),
    ...(authorization === undefined ? {} : { authorization }),
  })
}

async function expectNoRunRows(r: Repository, plan: Plan): Promise<void> {
  expect(await r.tickets.get(plan.ticketId)).toBeNull()
  expect(await r.plans.get(plan.planId)).toBeNull()
  expect(await r.attempts.listSince('2020-01-01T00:00:00.000Z')).toEqual([])
  expect(await r.outbox.countByStatus('pending')).toBe(0)
  expect(await r.lineage.listFor('plan', plan.planId)).toEqual([])
}

function success(plan: Plan): RunPlanResult {
  return {
    planId: plan.planId,
    status: 'succeeded',
    steps: [
      { stepId: 'dump', status: 'succeeded', attempts: 1, exitCode: 0, stdout: '', stderr: '', durationMs: 1 },
    ],
  }
}

function failure(plan: Plan): RunPlanResult {
  return {
    planId: plan.planId,
    status: 'failed',
    failedStep: 'dump',
    errorClass: 'permanent',
    error: 'pg_dump exited 2',
    steps: [
      { stepId: 'dump', status: 'failed', attempts: 1, exitCode: 2, stdout: '', stderr: 'boom', durationMs: 1 },
    ],
  }
}

describe('startRun', () => {
  it('persists the run envelope with the plan ticket and mandate identities', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    const ticket = await r.tickets.get(plan.ticketId)
    expect(ticket?.state).toBe('in_progress')
    expect(ticket?.targetId).toBe(target)
    expect(ticket?.principalId).toBe('os:roy')

    const mandate = await r.mandates.get(plan.mandateId)
    expect(mandate?.ticketId).toBe(plan.ticketId)

    const storedPlan = await r.plans.get(plan.planId)
    expect(storedPlan?.ticketId).toBe(plan.ticketId)
    expect(storedPlan?.state).toBe('dispatched')

    const attempt = await r.attempts.get(attemptId)
    expect(attempt?.state).toBe('running')
    expect(attempt?.targetId).toBe(target)
    expect(attempt?.leaseToken).toBe(lease.token)
    expect(attempt?.owner).toBe('worker-1')
    expect(attempt?.startedAt).toBe(T0)
    expect(attempt?.finishedAt).toBeNull()

    // The dispatch trace commits with the envelope: two lineage edges and one
    // audit event exist before any subprocess can run.
    const ticketEdges = await r.lineage.listFor('ticket', plan.ticketId)
    expect(ticketEdges).toHaveLength(1)
    expect(ticketEdges[0]).toMatchObject({ fromKind: 'ticket', toKind: 'plan', relation: 'spawned' })
    const planEdges = await r.lineage.listFor('plan', plan.planId)
    expect(planEdges).toHaveLength(2)
    expect(planEdges.map((edge) => edge.relation).sort()).toEqual(['attempted', 'spawned'])

    expect(await r.outbox.countByStatus('pending')).toBe(1)
    const started: unknown[] = []
    await dispatchOutbox(r, {
      now: () => at(10),
      handlers: {
        [OUTBOX_TOPIC_RUN_AUDIT]: async (record) => {
          started.push(record.payload)
        },
      },
    })
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      event: 'run.started',
      planId: plan.planId,
      ticketId: plan.ticketId,
      attemptId,
      targetId: target,
      lease: { owner: 'worker-1', token: lease.token },
    })
  })

  it('refuses to start under a superseded fence', async () => {
    const r = await open()
    const plan = makePlan()
    const stale = await r.transaction((tx) =>
      tx.leases.acquire({ targetId: target, owner: 'worker-1', now: T0, ttlMs: 60_000 }),
    )
    expect(stale?.token).toBe(1)
    await r.leases.release({ targetId: target, owner: 'worker-1', token: 1 })
    const current = await r.transaction((tx) =>
      tx.leases.acquire({ targetId: target, owner: 'worker-2', now: T0, ttlMs: 60_000 }),
    )
    expect(current?.token).toBe(2)

    const started = await startRun(r, {
      plan,
      principalId: 'os:roy',
      lease: stale!,
      attemptId: asAttemptId('att_1'),
      now: at(10),
    })

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('fence')
    expect(await r.tickets.get(plan.ticketId)).toBeNull()
    expect(await r.plans.get(plan.planId)).toBeNull()
  })
})

describe('startRun destructive authorization recheck', () => {
  const destructive = (overrides: Partial<Plan> = {}): Plan =>
    makePlan({ risk: 'destructive', ...overrides })

  it('denies a run whose approval was rejected after the CLI gate approved it', async () => {
    const r = await open()
    const plan = destructive()
    await r.assets.upsert(makeAsset({ environment: 'production' }))
    // The final CLI gate saw two current approvals and let the run through.
    await r.approvals.record(makeApproval('alice', 'approve'))
    await r.approvals.record(makeApproval('bob', 'approve'))
    // ... then, before the start transaction, bob retracts.
    await r.approvals.record(makeApproval('bob', 'reject', at(5)))

    const started = await startLeased(r, plan, AUTHORIZATION)

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('requires 2 distinct')
    await expectNoRunRows(r, plan)
  })

  it('counts only the latest decision per approver', async () => {
    const r = await open()
    const plan = destructive()
    await r.assets.upsert(makeAsset({ environment: 'production' }))
    await r.approvals.record(makeApproval('alice', 'approve'))
    await r.approvals.record(makeApproval('bob', 'approve'))
    await r.approvals.record(makeApproval('alice', 'reject', at(5)))

    const started = await startLeased(r, plan, AUTHORIZATION)

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('have 1')
    await expectNoRunRows(r, plan)
  })

  it('denies when the asset moved to production after a staging approval', async () => {
    const r = await open()
    const plan = destructive()
    // Approved as a staging target: no four eyes were required then.
    await r.assets.upsert(makeAsset({ environment: 'staging' }))
    // The asset is promoted before execution; nobody approved the new risk.
    await r.assets.upsert(makeAsset({ environment: 'production' }))

    const started = await startLeased(r, plan, AUTHORIZATION)

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('production-destructive')
    await expectNoRunRows(r, plan)
  })

  it('records the escalated risk when the current asset is production', async () => {
    const r = await open()
    const plan = destructive()
    await r.assets.upsert(makeAsset({ environment: 'production' }))
    await r.approvals.record(makeApproval('alice', 'approve'))
    await r.approvals.record(makeApproval('bob', 'approve'))

    const started = await startLeased(r, plan, AUTHORIZATION)

    expect(started.started).toBe(true)
    const stored = await r.plans.get(plan.planId)
    expect(stored?.payload.risk).toBe('production-destructive')
    expect((await r.mandates.get(plan.mandateId))?.allowedRisk).toBe('production-destructive')
  })

  it('denies a production plan whose approvals came only from the requester', async () => {
    const r = await open()
    const plan = destructive()
    await r.assets.upsert(makeAsset({ environment: 'production' }))
    await r.approvals.record(makeApproval('os:roy', 'approve'))
    await r.approvals.record(makeApproval('alice', 'approve'))

    const started = await startLeased(r, plan, AUTHORIZATION)

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('ignored self-approval')
    await expectNoRunRows(r, plan)
  })

  it('denies a destructive run without --yes', async () => {
    const r = await open()
    const plan = destructive()
    await r.assets.upsert(makeAsset())

    const started = await startLeased(r, plan, { ...AUTHORIZATION, confirmed: false })

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('--yes')
    await expectNoRunRows(r, plan)
  })

  it('denies a destructive run whose exact asset is no longer registered', async () => {
    const r = await open()
    const plan = destructive()

    const started = await startLeased(r, plan, AUTHORIZATION)

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('no asset registered')
    await expectNoRunRows(r, plan)
  })

  it('denies a destructive run started without an authorization recheck', async () => {
    const r = await open()
    const plan = destructive()
    await r.assets.upsert(makeAsset())

    const started = await startLeased(r, plan)

    expect(started.started).toBe(false)
    expect(started.started === false ? started.reason : '').toContain('without an authorization')
    await expectNoRunRows(r, plan)
  })

  it('throws instead of committing when called inside a caller transaction', async () => {
    const r = await open()
    const plan = destructive()
    await r.assets.upsert(makeAsset())

    await expect(
      r.transaction(async (tx) => {
        const lease = await tx.leases.acquire({
          targetId: target,
          owner: 'worker-1',
          now: T0,
          ttlMs: 60_000,
        })
        if (lease === null) throw new Error('lease denied in fixture')
        return startRunInTransaction(tx, {
          plan,
          principalId: 'os:roy',
          lease,
          attemptId: asAttemptId('att_tx'),
          now: at(10),
          authorization: { ...AUTHORIZATION, confirmed: false },
        })
      }),
    ).rejects.toBeInstanceOf(DestructiveAuthorizationDeniedError)

    await expectNoRunRows(r, plan)
    expect(await r.leases.get(target)).toBeNull()
    expect(await r.leases.currentFence(target)).toBe(0)
  })

  it('leaves reversible plans ungated', async () => {
    const r = await open()
    const plan = makePlan({ risk: 'reversible' })

    const started = await startLeased(r, plan)

    expect(started.started).toBe(true)
    expect(await r.plans.get(plan.planId)).not.toBeNull()
  })
})

describe('finishRun', () => {
  it('commits attempt, ticket, lineage and one audit event in one transaction', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    const outcome = await finishRun(r, {
      plan,
      result: success(plan),
      lease,
      attemptId,
      now: at(1_000),
      artifact: { path: '/tmp/missing.dump', kind: 'logical', verifiedLevel: 'V1' },
    })

    expect(outcome.persisted).toBe(true)
    expect((await r.attempts.get(attemptId))?.state).toBe('succeeded')
    expect((await r.attempts.get(attemptId))?.finishedAt).toBe(at(1_000))
    expect((await r.attempts.get(attemptId))?.leaseExpiresAt).toBeNull()
    expect((await r.tickets.get(plan.ticketId))?.state).toBe('succeeded')

    const artifacts = await r.artifacts.list({})
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]?.planId).toBe(plan.planId)
    expect(artifacts[0]?.targetId).toBe(target)
    expect(artifacts[0]?.path).toBe('/tmp/missing.dump')

    expect(await r.lineage.listFor('ticket', plan.ticketId)).toHaveLength(1)
    expect(await r.lineage.listFor('plan', plan.planId)).toHaveLength(2)
    expect(await r.lineage.listFor('attempt', attemptId)).toHaveLength(2)

    expect(await r.outbox.countByStatus('pending')).toBe(2)
    const records: Array<{ record: unknown; payload: unknown }> = []
    await dispatchOutbox(r, {
      now: () => at(2_000),
      handlers: {
        [OUTBOX_TOPIC_RUN_AUDIT]: async (record) => {
          records.push({ record, payload: record.payload })
        },
      },
    })
    expect(records).toHaveLength(2)
    expect(records.map((entry) => (entry.payload as { event: string }).event)).toEqual([
      'run.started',
      'run.finished',
    ])
    expect(records[1]?.payload).toMatchObject({
      event: 'run.finished',
      planId: plan.planId,
      ticketId: plan.ticketId,
      mandateId: plan.mandateId,
      targetId: target,
      attemptId,
      status: 'succeeded',
      artifactId: artifacts[0]?.id,
    })
    expect(await r.outbox.countByStatus('dispatched')).toBe(2)
    expect(await r.outbox.countByStatus('pending')).toBe(0)
  })

  it('enqueues a failure notification alongside the audit event', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    const outcome = await finishRun(r, {
      plan,
      result: failure(plan),
      lease,
      attemptId,
      now: at(1_000),
      artifact: { path: '/tmp/partial.dump', kind: 'logical', verifiedLevel: 'V1' },
    })

    expect(outcome.persisted).toBe(true)
    expect((await r.attempts.get(attemptId))?.state).toBe('failed')
    expect((await r.attempts.get(attemptId))?.errorClass).toBe('permanent')
    expect((await r.attempts.get(attemptId))?.exitCode).toBe(2)
    expect((await r.tickets.get(plan.ticketId))?.state).toBe('failed')
    // A failed run records no artifact path, even when one was supplied.
    expect(await r.artifacts.list({})).toEqual([])

    const notifications: unknown[] = []
    await dispatchOutbox(r, {
      now: () => at(2_000),
      handlers: {
        [OUTBOX_TOPIC_RUN_AUDIT]: async () => {},
        [OUTBOX_TOPIC_RUN_FAILURE]: async (record) => {
          notifications.push(record.payload)
        },
      },
    })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      severity: 'P2',
      title: 'backup failed: native-logical',
      labels: { targetId: target, planId: plan.planId },
    })
  })

  it('records cleanup and cleanupFailed in the audit event', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    const result = failure(plan)
    const outcome = await finishRun(r, {
      plan,
      result: {
        ...result,
        cleanup: [
          {
            stepId: 'stop-instance-on-failure',
            status: 'failed',
            attempts: 2,
            exitCode: 1,
            stdout: '',
            stderr: 'server still running',
            durationMs: 1,
          },
        ],
        cleanupFailed: ['stop-instance-on-failure'],
      },
      lease,
      attemptId,
      now: at(1_000),
    })
    expect(outcome.persisted).toBe(true)

    const audits: Array<Record<string, unknown>> = []
    await dispatchOutbox(r, {
      now: () => at(2_000),
      handlers: {
        [OUTBOX_TOPIC_RUN_AUDIT]: async (record) => {
          audits.push(record.payload as Record<string, unknown>)
        },
        [OUTBOX_TOPIC_RUN_FAILURE]: async () => {},
      },
    })
    const terminal = audits.find((payload) => payload['event'] === 'run.finished')
    expect(terminal).toMatchObject({
      cleanup: [{ stepId: 'stop-instance-on-failure', status: 'failed', attempts: 2 }],
      cleanupFailed: ['stop-instance-on-failure'],
    })
  })

  it('writes nothing for a lease-lost run and leaves the attempt running', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    const outcome = await finishRun(r, {
      plan,
      result: {
        planId: plan.planId,
        status: 'lease-lost',
        steps: [],
        leaseLost: { phase: 'after-step', message: 'lease lost' },
      },
      lease,
      attemptId,
      now: at(1_000),
    })

    expect(outcome).toEqual({ persisted: false, reason: 'lease was lost during execution' })
    expect((await r.attempts.get(attemptId))?.state).toBe('running')
    expect((await r.tickets.get(plan.ticketId))?.state).toBe('in_progress')
    // Only the start event is pending; no terminal audit or notification exists.
    expect(await r.outbox.countByStatus('pending')).toBe(1)
    expect(await r.lineage.listFor('plan', plan.planId)).toHaveLength(2)
  })

  it('leaves the attempt running when the fence was superseded', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    // A successor takes over the target while the run is finishing.
    await r.leases.release({ targetId: target, owner: lease.owner, token: lease.token })
    const takeover = await r.transaction((tx) =>
      tx.leases.acquire({ targetId: target, owner: 'worker-2', now: at(500), ttlMs: 60_000 }),
    )
    expect(takeover?.token).toBe(2)

    const outcome = await finishRun(r, {
      plan,
      result: success(plan),
      lease,
      attemptId,
      now: at(1_000),
      artifact: { path: '/tmp/dump', kind: 'logical', verifiedLevel: 'V1' },
    })

    expect(outcome.persisted).toBe(false)
    expect(outcome.persisted === false ? outcome.reason : '').toContain('fence')
    expect((await r.attempts.get(attemptId))?.state).toBe('running')
    expect(await r.outbox.countByStatus('pending')).toBe(1)
    expect(await r.artifacts.list({})).toEqual([])
  })

  it('leaves the attempt running when the lease row expired without a takeover', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    // No successor advanced the fence, but the lease row itself is past its
    // expiry: authority is gone, so nothing terminal may commit.
    const outcome = await finishRun(r, {
      plan,
      result: success(plan),
      lease,
      attemptId,
      now: at(120_000),
    })

    expect(outcome.persisted).toBe(false)
    expect(outcome.persisted === false ? outcome.reason : '').toContain('expired')
    expect((await r.attempts.get(attemptId))?.state).toBe('running')
    expect(await r.outbox.countByStatus('pending')).toBe(1)
    expect(await r.lineage.listFor('plan', plan.planId)).toHaveLength(2)
  })

  it('rolls every terminal write back when the surrounding transaction aborts', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    await expect(
      r.transaction(async (tx) => {
        const outcome = await finishRunInTransaction(tx, {
          plan,
          result: success(plan),
          lease,
          attemptId,
          now: at(1_000),
          artifact: { path: '/tmp/dump', kind: 'logical', verifiedLevel: 'V1' },
        })
        expect(outcome.persisted).toBe(true)
        throw new Error('abort after terminal writes')
      }),
    ).rejects.toThrow('abort after terminal writes')

    expect((await r.attempts.get(attemptId))?.state).toBe('running')
    expect((await r.tickets.get(plan.ticketId))?.state).toBe('in_progress')
    // The start event survives; the terminal audit event was rolled back with
    // the rest of the terminal transaction.
    expect(await r.outbox.countByStatus('pending')).toBe(1)
    expect(await r.artifacts.list({})).toEqual([])
    expect(await r.lineage.listFor('plan', plan.planId)).toHaveLength(2)
  })

  it('does not record a terminal state twice', async () => {
    const r = await open()
    const plan = makePlan()
    const { lease, attemptId } = await beginRun(r, plan)

    const first = await finishRun(r, {
      plan,
      result: success(plan),
      lease,
      attemptId,
      now: at(1_000),
    })
    expect(first.persisted).toBe(true)

    const second = await finishRun(r, {
      plan,
      result: success(plan),
      lease,
      attemptId,
      now: at(1_100),
    })
    expect(second.persisted).toBe(false)
    expect(second.persisted === false ? second.reason : '').toContain('cannot become')
    expect(await r.outbox.countByStatus('pending')).toBe(2)
  })
})
