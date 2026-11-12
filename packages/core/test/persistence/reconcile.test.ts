import { afterEach, describe, expect, it } from 'vitest'

import { asAttemptId, asMandateId, asPlanId, asTargetId, asTicketId } from '../../src/domain/ids'
import { dispatchOutbox } from '../../src/persistence/outbox-dispatch'
import { reconcile } from '../../src/persistence/reconcile'
import { OUTBOX_TOPIC_RUN_AUDIT, OUTBOX_TOPIC_RUN_FAILURE } from '../../src/persistence/run-lifecycle'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { Repository } from '../../src/ports/repository'

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

async function seed(r: Repository): Promise<void> {
  await r.tickets.insert({
    id: asTicketId('tkt_1'),
    principalId: 'user:roy',
    targetId: target,
    goal: 'nightly backup',
    state: 'in_progress',
    createdAt: T0,
    updatedAt: T0,
  })
  await r.mandates.insert({
    id: asMandateId('mnd_1'),
    ticketId: asTicketId('tkt_1'),
    principalId: 'user:roy',
    scope: 'backup',
    policyVersion: '1',
    allowedRisk: 'destructive',
    issuedAt: T0,
    expiresAt: at(10_000),
  })
  await r.plans.insert({
    id: asPlanId('pln_1'),
    ticketId: asTicketId('tkt_1'),
    mandateId: asMandateId('mnd_1'),
    state: 'dispatched',
    payload: {} as never,
    fingerprintDigest: 'digest',
    createdAt: T0,
    updatedAt: T0,
  })
}

async function runningAttempt(
  r: Repository,
  input: {
    id: string
    leaseToken: number
    leaseExpiresAt: string
    startedAt: string
    targetId?: ReturnType<typeof asTargetId> | null
  },
): Promise<void> {
  await r.attempts.insert({
    id: asAttemptId(input.id),
    planId: asPlanId('pln_1'),
    state: 'running',
    owner: `worker-${input.leaseToken}`,
    leaseToken: input.leaseToken,
    leaseExpiresAt: input.leaseExpiresAt,
    startedAt: input.startedAt,
    finishedAt: null,
    exitCode: null,
    targetId: input.targetId === undefined ? target : input.targetId,
  })
}

describe('reconcile', () => {
  it('stalls only attempts whose live lease is gone and reports outbox state', async () => {
    const r = await open()
    await seed(r)

    // No lease row at all: the runner's authority is gone.
    await runningAttempt(r, {
      id: 'att_absent',
      leaseToken: 1,
      leaseExpiresAt: at(1_000),
      startedAt: T0,
    })
    // Long run that renewed past its dispatch-time timestamp: still authoritative.
    await runningAttempt(r, {
      id: 'att_live',
      leaseToken: 2,
      leaseExpiresAt: at(1_000),
      startedAt: at(100),
    })
    // A newer fencing token owns the target: this attempt is superseded.
    await runningAttempt(r, {
      id: 'att_superseded',
      leaseToken: 1,
      leaseExpiresAt: at(9_000),
      startedAt: at(200),
    })
    // Matching token but the lease row itself expired.
    await runningAttempt(r, {
      id: 'att_expired_lease',
      leaseToken: 1,
      leaseExpiresAt: at(2_500),
      startedAt: at(300),
      targetId: asTargetId('pg-stale'),
    })
    // Legacy row without a target: reconciliation cannot verify it and leaves it.
    await runningAttempt(r, {
      id: 'att_unknown_target',
      leaseToken: 1,
      leaseExpiresAt: at(1_000),
      startedAt: at(400),
      targetId: null,
    })

    const live = await r.transaction((tx) =>
      tx.leases.acquire({ targetId: target, owner: 'worker-live', now: at(2_000), ttlMs: 10_000 }),
    )
    expect(live?.token).toBe(1)
    // Take over to reach token 2 for the live attempt, then let token 3 expire.
    await r.leases.release({ targetId: target, owner: 'worker-live', token: 1 })
    const second = await r.transaction((tx) =>
      tx.leases.acquire({ targetId: target, owner: 'worker-2', now: at(2_000), ttlMs: 10_000 }),
    )
    expect(second?.token).toBe(2)

    const expiring = await r.transaction((tx) =>
      tx.leases.acquire({
        targetId: asTargetId('pg-stale'),
        owner: 'worker-3',
        now: at(2_000),
        ttlMs: 500,
      }),
    )
    expect(expiring?.token).toBe(1)

    await r.outbox.append({ topic: 'notify', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })
    await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })

    const report = await reconcile(r, at(3_000))
    expect(report.stalledAttempts).toEqual([
      asAttemptId('att_absent'),
      asAttemptId('att_superseded'),
      asAttemptId('att_expired_lease'),
    ])
    expect(report.requeuedOutbox).toBe(1)
    // Three stalled attempts each append an audit event plus a failure
    // notification; the pre-existing claimed row is still processing.
    expect(report.outbox).toMatchObject({
      pending: 6,
      processing: 1,
      dispatched: 0,
      deadLetter: 0,
      expiredProcessing: 1,
    })

    const absent = await r.attempts.get(asAttemptId('att_absent'))
    expect(absent?.state).toBe('stalled')
    expect(absent?.finishedAt).toBe(at(3_000))
    expect(absent?.leaseExpiresAt).toBeNull()

    expect((await r.attempts.get(asAttemptId('att_live')))?.state).toBe('running')
    expect((await r.attempts.get(asAttemptId('att_superseded')))?.state).toBe('stalled')
    expect((await r.attempts.get(asAttemptId('att_expired_lease')))?.state).toBe('stalled')
    expect((await r.attempts.get(asAttemptId('att_unknown_target')))?.state).toBe('running')
  })

  it('keeps a running attempt whose matching lease is alive beyond the attempt timestamp', async () => {
    const r = await open()
    await seed(r)
    await runningAttempt(r, {
      id: 'att_long',
      leaseToken: 1,
      leaseExpiresAt: at(1_000),
      startedAt: T0,
    })
    const lease = await r.transaction((tx) =>
      tx.leases.acquire({ targetId: target, owner: 'worker-1', now: T0, ttlMs: 60_000 }),
    )
    expect(lease?.token).toBe(1)
    // The heartbeat keeps extending the live lease past the attempt's stored
    // dispatch-time timestamp.
    expect(
      await r.leases.renew({
        targetId: target,
        owner: 'worker-1',
        token: 1,
        now: at(30_000),
        ttlMs: 7_200_000,
      }),
    ).toBe(true)

    // An hour after dispatch the attempt timestamp is long past, but the live
    // lease was renewed; reconciliation must not stall a healthy run.
    const report = await reconcile(r, at(3_600_000))
    expect(report.stalledAttempts).toEqual([])
    expect((await r.attempts.get(asAttemptId('att_long')))?.state).toBe('running')
  })

  it('records a deterministic audit event and failure notification when stalling', async () => {
    const r = await open()
    await seed(r)
    await runningAttempt(r, {
      id: 'att_crash',
      leaseToken: 1,
      leaseExpiresAt: at(1_000),
      startedAt: T0,
    })

    expect((await reconcile(r, at(2_000))).stalledAttempts).toEqual([asAttemptId('att_crash')])
    expect(await r.outbox.countByStatus('pending')).toBe(2)

    const audit: unknown[] = []
    const notifications: unknown[] = []
    await dispatchOutbox(r, {
      now: () => at(3_000),
      handlers: {
        [OUTBOX_TOPIC_RUN_AUDIT]: async (record) => {
          audit.push(record.payload)
        },
        [OUTBOX_TOPIC_RUN_FAILURE]: async (record) => {
          notifications.push(record.payload)
        },
      },
    })

    expect(audit).toEqual([
      {
        event: 'attempt.stalled',
        attemptId: 'att_crash',
        planId: 'pln_1',
        targetId: 'pg-prod',
        owner: 'worker-1',
        leaseToken: 1,
        detectedAt: at(2_000),
      },
    ])
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      severity: 'P2',
      title: 'backup run stalled: pln_1',
      labels: { targetId: 'pg-prod', planId: 'pln_1', attemptId: 'att_crash' },
    })
  })

  it('stalls when the token matches but the live lease belongs to another owner', async () => {
    const r = await open()
    await seed(r)
    await runningAttempt(r, {
      id: 'att_owner_mismatch',
      leaseToken: 1,
      leaseExpiresAt: at(1_000),
      startedAt: T0,
    })
    const lease = await r.transaction((tx) =>
      tx.leases.acquire({ targetId: target, owner: 'worker-real', now: T0, ttlMs: 3_600_000 }),
    )
    expect(lease?.token).toBe(1)

    expect((await reconcile(r, at(60_000))).stalledAttempts).toEqual([
      asAttemptId('att_owner_mismatch'),
    ])
  })

  it('is a no-op when nothing expired', async () => {
    const r = await open()
    await seed(r)
    expect(await reconcile(r, T0)).toEqual({
      stalledAttempts: [],
      requeuedOutbox: 0,
      outbox: { pending: 0, processing: 0, dispatched: 0, deadLetter: 0, expiredProcessing: 0, oldestPendingAt: null },
    })
  })
})
