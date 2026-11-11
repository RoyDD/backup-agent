import { afterEach, describe, expect, it } from 'vitest'

import { asAttemptId, asMandateId, asPlanId, asTargetId, asTicketId } from '../../src/domain/ids'
import { reconcile } from '../../src/persistence/reconcile'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { Repository } from '../../src/ports/repository'

const T0 = '2026-01-01T00:00:00.000Z'
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString()

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
    targetId: asTargetId('pg-prod'),
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

describe('reconcile', () => {
  it('stalls expired running attempts and reports re-leasable outbox rows', async () => {
    const r = await open()
    await seed(r)

    await r.attempts.insert({
      id: asAttemptId('att_expired'),
      planId: asPlanId('pln_1'),
      state: 'running',
      owner: 'worker-a',
      leaseToken: 1,
      leaseExpiresAt: at(1_000),
      startedAt: T0,
      finishedAt: null,
      exitCode: null,
    })
    await r.attempts.insert({
      id: asAttemptId('att_live'),
      planId: asPlanId('pln_1'),
      state: 'running',
      owner: 'worker-b',
      leaseToken: 2,
      leaseExpiresAt: at(9_000),
      startedAt: T0,
      finishedAt: null,
      exitCode: null,
    })

    await r.outbox.append({ topic: 'notify', payload: {}, idempotencyKey: 'k-1', availableAt: T0 })
    await r.outbox.claim({ now: T0, limit: 10, leaseMs: 1_000 })

    const report = await reconcile(r, at(2_000))
    expect(report.stalledAttempts).toEqual([asAttemptId('att_expired')])
    expect(report.requeuedOutbox).toBe(1)

    const expired = await r.attempts.get(asAttemptId('att_expired'))
    expect(expired?.state).toBe('stalled')
    expect(expired?.finishedAt).toBe(at(2_000))
    expect(expired?.leaseExpiresAt).toBeNull()

    expect((await r.attempts.get(asAttemptId('att_live')))?.state).toBe('running')
  })

  it('is a no-op when nothing expired', async () => {
    const r = await open()
    await seed(r)
    expect(await reconcile(r, T0)).toEqual({ stalledAttempts: [], requeuedOutbox: 0 })
  })
})
