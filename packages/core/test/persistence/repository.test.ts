import { afterEach, describe, expect, it } from 'vitest'

import { asMandateId, asPlanId, asTargetId, asTicketId } from '../../src/domain/ids'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { Repository } from '../../src/ports/repository'

const NOW = '2026-01-01T01:00:00.000Z'

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
    state: 'open',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await r.mandates.insert({
    id: asMandateId('mnd_1'),
    ticketId: asTicketId('tkt_1'),
    principalId: 'user:roy',
    scope: 'backup',
    policyVersion: '1',
    allowedRisk: 'destructive',
    issuedAt: NOW,
    expiresAt: '2026-01-01T03:00:00.000Z',
  })
  await r.plans.insert({
    id: asPlanId('pln_1'),
    ticketId: asTicketId('tkt_1'),
    mandateId: asMandateId('mnd_1'),
    state: 'validated',
    payload: {
      planId: asPlanId('pln_1'),
      ticketId: asTicketId('tkt_1'),
      mandateId: asMandateId('mnd_1'),
      engine: 'postgres',
      provider: 'native-logical',
      targetId: asTargetId('pg-prod'),
      fingerprint: {
        systemIdentifier: 'sys-1',
        configDigest: 'cfg-1',
        targetOid: 'oid-1',
        createdAt: NOW,
        expiresAt: '2026-01-01T03:00:00.000Z',
      },
      steps: [],
      resources: { estimatedBytes: 1, estimatedDurationMs: 1, concurrencySlots: 1 },
      risk: 'reversible',
    },
    fingerprintDigest: 'digest-1',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describe('SqliteRepository', () => {
  it('round-trips tickets and updates state', async () => {
    const r = await open()
    await seed(r)

    const ticket = await r.tickets.get(asTicketId('tkt_1'))
    expect(ticket?.goal).toBe('nightly backup')

    await r.tickets.updateState(asTicketId('tkt_1'), 'scheduled', NOW)
    expect((await r.tickets.get(asTicketId('tkt_1')))?.state).toBe('scheduled')
    expect(await r.tickets.listByState('scheduled')).toHaveLength(1)
  })

  it('round-trips mandates and plans', async () => {
    const r = await open()
    await seed(r)

    expect((await r.mandates.get(asMandateId('mnd_1')))?.allowedRisk).toBe('destructive')
    const plan = await r.plans.get(asPlanId('pln_1'))
    expect(plan?.fingerprintDigest).toBe('digest-1')
    expect(plan?.payload.provider).toBe('native-logical')
    expect(await r.plans.listByTicket(asTicketId('tkt_1'))).toHaveLength(1)
  })

  it('rolls a transaction back when the callback throws', async () => {
    const r = await open()
    await expect(
      r.transaction(async (tx) => {
        await tx.tickets.insert({
          id: asTicketId('tkt_tx'),
          principalId: 'user:roy',
          targetId: asTargetId('pg-prod'),
          goal: 'should vanish',
          state: 'open',
          createdAt: NOW,
          updatedAt: NOW,
        })
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')

    expect(await r.tickets.get(asTicketId('tkt_tx'))).toBeNull()
  })

  it('enforces foreign keys', async () => {
    const r = await open()
    await expect(
      r.plans.insert({
        id: asPlanId('pln_orphan'),
        ticketId: asTicketId('missing'),
        mandateId: asMandateId('missing'),
        state: 'drafted',
        payload: {} as never,
        fingerprintDigest: 'x',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow()
  })

  it('keeps approval decisions append-only and ordered', async () => {
    const r = await open()
    const targetId = asTargetId('pg-prod')
    const base = {
      targetId,
      configDigest: 'cfg-1',
      approver: 'alice',
      reason: null,
    }
    await r.approvals.record({
      ...base,
      id: 'apr_1',
      decision: 'approve',
      createdAt: '2026-01-01T00:10:00.000Z',
    })
    await r.approvals.record({
      ...base,
      id: 'apr_2',
      decision: 'reject',
      createdAt: '2026-01-01T00:20:00.000Z',
    })

    const decisions = await r.approvals.listFor(targetId, 'cfg-1', '2026-01-01T00:00:00.000Z')
    expect(decisions.map((decision) => `${decision.id}:${decision.decision}`)).toEqual([
      'apr_1:approve',
      'apr_2:reject',
    ])
  })
})
