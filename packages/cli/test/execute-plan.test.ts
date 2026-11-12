import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import {
  asMandateId,
  asPlanId,
  asTargetId,
  asTicketId,
  type ApprovalRecord,
  type AssetDescriptor,
  type InstanceInfo,
  type LeaseRecord,
  type Plan,
  type Repository,
  type Step,
  type TargetId,
} from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'
import { FakeExecutor } from '@backup-agent/core/testkit'

import {
  buildPlanContext,
  executePlan,
  planIssueText,
  reportPlanOutcome,
  validateForExecution,
} from '../src/execute-plan'

const INSTANCE: InstanceInfo = {
  version: 'PostgreSQL 16.15',
  serverVersionNum: 160015,
  currentUser: 'backup',
  currentDatabase: 'app',
  databaseOid: null,
  inRecovery: false,
  systemIdentifier: '7421000000000000001',
  walLevel: 'replica',
  archiveMode: 'on',
  databases: ['app'],
  executionSite: 'local',
  warnings: [],
}

const TARGET: TargetId = asTargetId('pg-prod')

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function controlDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bkagent-lease-'))
  workspaces.push(dir)
  return join(dir, 'control.db')
}

async function withRepo<T>(file: string, fn: (repo: Repository) => Promise<T>): Promise<T> {
  const repo = await createSqliteRepository({ filename: file })
  await repo.migrate()
  try {
    return await fn(repo)
  } finally {
    await repo.close()
  }
}

async function acquireLease(
  file: string,
  owner: string,
  ttlMs = 60_000,
  at = new Date().toISOString(),
): Promise<LeaseRecord> {
  return withRepo(file, async (repo) => {
    const lease = await repo.transaction((tx) =>
      tx.leases.acquire({
        targetId: TARGET,
        owner,
        now: at,
        ttlMs,
      }),
    )
    if (lease === null) throw new Error(`expected ${owner} to acquire the lease`)
    return lease
  })
}

async function releaseLease(file: string, lease: LeaseRecord): Promise<void> {
  await withRepo(file, (repo) =>
    repo.leases.release({ targetId: lease.targetId, owner: lease.owner, token: lease.token }),
  )
}

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    stepId: 'dump',
    kind: 'exec',
    dependsOn: [],
    argv: ['pg_dump', '-Fc'],
    preconditions: [],
    postconditions: [],
    retry: {
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoff: 'none',
      retryOn: [],
    },
    checkpoint: 'none',
    idempotencyKey: 'dump-1',
    ...overrides,
  }
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: asPlanId('pln_test'),
    ticketId: asTicketId('tkt_test'),
    mandateId: asMandateId('mnd_test'),
    engine: 'postgres',
    provider: 'native-logical',
    targetId: TARGET,
    fingerprint: {
      systemIdentifier: '7421000000000000001',
      configDigest: 'cfg-1',
      targetOid: 'oid-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T02:00:00.000Z',
    },
    steps: [makeStep()],
    resources: {
      estimatedBytes: 1_000,
      estimatedDurationMs: 5_000,
      concurrencySlots: 1,
    },
    risk: 'reversible',
    ...overrides,
  }
}

describe('buildPlanContext', () => {
  it('issues fresh ticket and mandate ids while preserving the probe envelope', () => {
    const first = buildPlanContext(INSTANCE, 'cfg-1')
    const second = buildPlanContext(INSTANCE, 'cfg-1')

    expect(first.instance).toBe(INSTANCE)
    expect(first.configDigest).toBe('cfg-1')
    expect(Number.isFinite(Date.parse(first.now))).toBe(true)
    expect(first.ticketId).not.toBe(second.ticketId)
    expect(first.mandateId).not.toBe(second.mandateId)
    expect(first.ticketId.startsWith('tkt_')).toBe(true)
    expect(first.mandateId.startsWith('mnd_')).toBe(true)
  })
})

describe('validateForExecution', () => {
  it('accepts a well-formed plan', () => {
    expect(validateForExecution(makePlan(), 'os:tester')).toEqual([])
  })

  it('rejects shell metacharacters in argv', () => {
    const plan = makePlan({ steps: [makeStep({ argv: ['pg_dump', 'app; rm -rf /'] })] })
    const issues = validateForExecution(plan, 'os:tester')

    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('SCHEMA')
    expect(issues[0]?.path).toBe('steps[0].argv[1]')
    expect(issues[0]?.message).toContain('shell metacharacters')
  })
})

describe('planIssueText', () => {
  it('serializes issues with ok:false', () => {
    const payload = JSON.parse(planIssueText([{ code: 'SCHEMA', path: 'planId', message: 'bad' }])) as {
      ok: boolean
      issues: unknown[]
    }
    expect(payload.ok).toBe(false)
    expect(payload.issues).toHaveLength(1)
  })
})

describe('executePlan', () => {
  it('runs argv-only steps and streams start events to the injected writer', async () => {
    const db = await controlDb()
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })
    const stderr: string[] = []

    const { result } = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: (text) => stderr.push(text),
      controlDb: db,
      env: { PGPASSWORD: 'secret' },
    })

    expect(result.status).toBe('succeeded')
    expect(stderr).toEqual(['[dump] running\n'])
    expect(executor.calls).toHaveLength(1)
    expect(executor.calls[0]?.argv).toEqual(['pg_dump', '-Fc'])
    expect(executor.calls[0]?.opts?.env).toEqual({ PGPASSWORD: 'secret' })
  })

  it('reports a failed step without throwing', async () => {
    const db = await controlDb()
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { exitCode: 2, stderr: 'boom' } })

    const { result } = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
    })

    expect(result.status).toBe('failed')
    expect(result.failedStep).toBe('dump')
  })

  it('holds the target lease for the run and advances the fence per run', async () => {
    const db = await controlDb()
    const firstExecutor = new FakeExecutor()
    firstExecutor.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })
    const secondExecutor = new FakeExecutor()
    secondExecutor.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })

    const first = await executePlan(
      makePlan({
        planId: asPlanId('pln_first'),
        ticketId: asTicketId('tkt_first'),
        mandateId: asMandateId('mnd_first'),
      }),
      INSTANCE,
      {
        executor: firstExecutor,
        writeError: () => {},
        controlDb: db,
        principalId: 'os:tester',
      },
    )
    const second = await executePlan(
      makePlan({
        planId: asPlanId('pln_second'),
        ticketId: asTicketId('tkt_second'),
        mandateId: asMandateId('mnd_second'),
      }),
      INSTANCE,
      {
        executor: secondExecutor,
        writeError: () => {},
        controlDb: db,
        principalId: 'os:tester',
      },
    )

    expect(first.lease?.token).toBe(1)
    expect(second.lease?.token).toBe(2)
    expect(first.lease?.targetId).toBe(TARGET)
    // Never a constant owner: same principal, distinct run identity.
    expect(first.lease?.owner).not.toBe(second.lease?.owner)
    expect(first.lease?.owner.startsWith('os:tester:')).toBe(true)
    expect(first.lease?.owner).toContain(String(process.pid))

    await withRepo(db, async (repo) => {
      expect(await repo.leases.get(TARGET)).toBeNull()
      expect(await repo.leases.currentFence(TARGET)).toBe(2)
    })
  })

  it('denies execution when another owner holds the target lease', async () => {
    const db = await controlDb()
    const held = await acquireLease(db, 'other-worker')
    expect(held.token).toBe(1)
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })

    const execution = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
    })

    expect(execution.result.status).toBe('failed')
    expect(execution.result.error).toContain('lease unavailable')
    expect(execution.result.steps).toEqual([])
    expect(execution.lease).toBeNull()
    expect(executor.calls).toHaveLength(0)

    await releaseLease(db, held)
  })

  it('does not dispatch the first step when the lease cannot be acquired', async () => {
    const db = await controlDb()
    const held = await acquireLease(db, 'other-worker')
    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })

    const execution = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
    })

    expect(execution.result.status).not.toBe('succeeded')
    expect(executor.calls).toHaveLength(0)
    // The other owner keeps its lease; a denied run never releases it.
    await withRepo(db, async (repo) => {
      const lease = await repo.leases.get(TARGET)
      expect(lease?.owner).toBe('other-worker')
      expect(lease?.token).toBe(1)
    })
    await releaseLease(db, held)
  })

  it('aborts the run and stops dispatching when the heartbeat loses the lease', async () => {
    const db = await controlDb()
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { delayMs: 60, stdout: 'partial' } })
    executor.enqueue({ match: ['verify'], response: { stdout: 'ok' } })
    const plan = makePlan({
      steps: [
        makeStep(),
        makeStep({ stepId: 'verify', argv: ['verify'], dependsOn: ['dump'], idempotencyKey: 'verify' }),
      ],
    })
    let clock = Date.parse('2026-01-01T00:00:00.000Z')
    const now = (): string => {
      const value = new Date(clock).toISOString()
      // Each observation advances a minute. The lease is long enough for the
      // start write, but the heartbeat's renewal lands past its expiry.
      clock += 60_000
      return value
    }

    const execution = await executePlan(plan, INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
      now,
      lease: { ttlMs: 120_000, heartbeatMs: 10 },
    })

    expect(execution.result.status).toBe('lease-lost')
    expect(execution.result.steps.map((step) => step.stepId)).toEqual(['dump'])
    expect(execution.result.steps[0]?.status).toBe('lease-lost')
    expect(execution.result.leaseLost?.phase).toBe('after-step')
    expect(executor.calls).toHaveLength(1)
    expect(executor.calls[0]?.opts?.signal?.aborted).toBe(true)

    await withRepo(db, async (repo) => {
      expect(await repo.leases.get(TARGET)).toBeNull()
    })
  })

  it('releases the lease after a failed run so the next run can proceed', async () => {
    const db = await controlDb()
    const failing = new FakeExecutor()
    failing.enqueue({ match: ['pg_dump', '-Fc'], response: { exitCode: 2, stderr: 'boom' } })

    const execution = await executePlan(
      makePlan({ planId: asPlanId('pln_fail'), ticketId: asTicketId('tkt_fail'), mandateId: asMandateId('mnd_fail') }),
      INSTANCE,
      {
        executor: failing,
        writeError: () => {},
        controlDb: db,
      },
    )

    expect(execution.result.status).toBe('failed')
    await withRepo(db, async (repo) => {
      expect(await repo.leases.get(TARGET)).toBeNull()
      expect(await repo.leases.currentFence(TARGET)).toBe(execution.lease?.token)
    })

    const succeeding = new FakeExecutor()
    succeeding.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })
    const next = await executePlan(
      makePlan({ planId: asPlanId('pln_next'), ticketId: asTicketId('tkt_next'), mandateId: asMandateId('mnd_next') }),
      INSTANCE,
      {
        executor: succeeding,
        writeError: () => {},
        controlDb: db,
      },
    )
    expect(next.result.status).toBe('succeeded')
    expect(next.lease?.token).toBe(2)
  })
})

describe('executePlan run lifecycle', () => {
  it('persists the running attempt before the first subprocess', async () => {
    const db = await controlDb()
    const observed: Array<{ state: string; target: string | null; token: number }> = []
    const executor = new FakeExecutor({
      defaultHandler: () => {
        // Read the control db from inside the executor: this is the moment the
        // first subprocess would start, so the run envelope must already exist.
        const handle = new DatabaseSync(db)
        try {
          const row = handle
            .prepare('SELECT state, target_id, lease_token FROM attempts')
            .get() as { state: string; target_id: string | null; lease_token: number } | undefined
          if (row !== undefined) {
            observed.push({ state: row.state, target: row.target_id, token: row.lease_token })
          }
        } finally {
          handle.close()
        }
        return { stdout: 'ok' }
      },
    })

    const execution = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
    })

    expect(execution.result.status).toBe('succeeded')
    expect(observed).toEqual([{ state: 'running', target: TARGET, token: 1 }])
    expect(execution.attemptId).not.toBeNull()
    expect(execution.persistence).toMatchObject({ persisted: true })

    await withRepo(db, async (repo) => {
      const attempt = await repo.attempts.get(execution.attemptId!)
      expect(attempt?.state).toBe('succeeded')
      expect(attempt?.targetId).toBe(TARGET)
      // The plan's own ticket identity, not a freshly invented one.
      expect((await repo.tickets.get(asTicketId('tkt_test')))?.state).toBe('succeeded')
      // start + terminal audit events
      expect(await repo.outbox.countByStatus('pending')).toBe(2)
      expect(await repo.lineage.listFor('plan', asPlanId('pln_test'))).toHaveLength(2)
    })
  })

  it('dispatches no subprocess when the start envelope cannot be persisted', async () => {
    const db = await controlDb()
    const first = new FakeExecutor()
    first.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })
    const firstRun = await executePlan(makePlan(), INSTANCE, {
      executor: first,
      writeError: () => {},
      controlDb: db,
    })
    expect(firstRun.result.status).toBe('succeeded')

    // Re-running the same Plan identity collides with the persisted ticket; the
    // start transaction must roll back instead of letting the step run.
    const second = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })
    await expect(
      executePlan(makePlan(), INSTANCE, {
        executor: second,
        writeError: () => {},
        controlDb: db,
      }),
    ).rejects.toThrow()

    expect(second.calls).toHaveLength(0)
    await withRepo(db, async (repo) => {
      const attempts = await repo.attempts.listSince('2020-01-01T00:00:00.000Z')
      expect(attempts).toHaveLength(1)
    })
  })

  it('records a failure notification outbox event for a failed run', async () => {
    const db = await controlDb()
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { exitCode: 2, stderr: 'boom' } })

    const execution = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
    })

    expect(execution.result.status).toBe('failed')
    await withRepo(db, async (repo) => {
      // start audit + terminal audit + notify.failure
      expect(await repo.outbox.countByStatus('pending')).toBe(3)
      const attempt = await repo.attempts.get(execution.attemptId!)
      expect(attempt?.state).toBe('failed')
      expect(attempt?.errorClass).toBe('permanent')
    })
  })

  it('carries the persisted attemptId into the terminal callback', async () => {
    const db = await controlDb()
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })
    const calls: Array<{ status: string; attemptId: string; token: number }> = []

    const execution = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
      recordOutcome: async (result, lease, attemptId) => {
        calls.push({ status: result.status, attemptId, token: lease.token })
      },
    })

    expect(calls).toEqual([
      { status: 'succeeded', attemptId: execution.attemptId, token: execution.lease?.token },
    ])
  })

  it('reports lease-lost when the terminal state cannot be persisted', async () => {
    const db = await controlDb()
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    let expired = false
    const now = (): string => new Date(base + (expired ? 120_000 : 0)).toISOString()
    const executor = new FakeExecutor({
      defaultHandler: () => {
        // The lease expires while the subprocess runs; no successor takes over.
        expired = true
        return { stdout: 'ok' }
      },
    })
    const stderr: string[] = []

    const execution = await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: (text) => stderr.push(text),
      controlDb: db,
      now,
      lease: { ttlMs: 60_000, heartbeatMs: 30_000 },
    })

    expect(execution.result.status).toBe('lease-lost')
    expect(execution.result.error).toContain('terminal state was not persisted')
    expect(execution.result.error).toContain('expired')
    expect(execution.persistence).toMatchObject({ persisted: false })
    expect(stderr.join('')).toContain('run outcome not recorded')
    // The CLI must not report success for an unrecorded run.
    expect(reportPlanOutcome(makePlan(), execution.result, () => {})).toBe(1)

    await withRepo(db, async (repo) => {
      expect((await repo.attempts.get(execution.attemptId!))?.state).toBe('running')
      // Only the start audit event exists; no terminal/outbox outcome.
      expect(await repo.outbox.countByStatus('pending')).toBe(1)
    })
  })

  it('does not invent an artifact for provider-managed runs', async () => {
    const db = await controlDb()
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })

    await executePlan(makePlan(), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
    })

    await withRepo(db, async (repo) => {
      expect(await repo.artifacts.list({})).toEqual([])
    })
  })
})

describe('executePlan destructive authorization recheck', () => {
  const AUTHORIZATION = {
    confirmed: true,
    requester: 'os:tester',
    osPrincipal: 'os:tester',
  } as const

  function makeAsset(overrides: Partial<AssetDescriptor> = {}): AssetDescriptor {
    return {
      targetId: TARGET,
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
    createdAt: string,
  ): ApprovalRecord {
    return {
      id: `apr_${approver}_${decision}_${createdAt}`,
      targetId: TARGET,
      configDigest: 'cfg-1',
      approver,
      decision,
      reason: null,
      createdAt,
    }
  }

  const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()

  it('denies before the executor when an approval was rejected after the final CLI gate', async () => {
    const db = await controlDb()
    // The final CLI gate saw two current approvals and authorized the plan.
    await withRepo(db, async (repo) => {
      await repo.assets.upsert(makeAsset({ environment: 'production' }))
      await repo.approvals.record(makeApproval('alice', 'approve', iso(-2_000)))
      await repo.approvals.record(makeApproval('bob', 'approve', iso(-2_000)))
      // ... then a reject lands in the window before the start transaction.
      await repo.approvals.record(makeApproval('bob', 'reject', iso(-1_000)))
    })

    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })
    const stderr: string[] = []

    const execution = await executePlan(makePlan({ risk: 'destructive' }), INSTANCE, {
      executor,
      writeError: (text) => stderr.push(text),
      controlDb: db,
      principalId: 'os:tester',
      authorization: AUTHORIZATION,
    })

    expect(execution.result.status).toBe('failed')
    expect(execution.result.error).toContain('approvals-insufficient')
    expect(execution.result.error).toContain('requires 2 distinct')
    expect(execution.lease).toBeNull()
    expect(execution.attemptId).toBeNull()
    expect(execution.persistence).toBeNull()
    expect(executor.calls).toHaveLength(0)
    expect(stderr.join('')).toContain('destructive authorization')

    await withRepo(db, async (repo) => {
      expect(await repo.attempts.listSince('2020-01-01T00:00:00.000Z')).toEqual([])
      expect(await repo.plans.get(asPlanId('pln_test'))).toBeNull()
      expect(await repo.tickets.get(asTicketId('tkt_test'))).toBeNull()
      expect(await repo.outbox.countByStatus('pending')).toBe(0)
      // The lease acquisition rolled back with the denial; no fence bump either.
      expect(await repo.leases.get(TARGET)).toBeNull()
      expect(await repo.leases.currentFence(TARGET)).toBe(0)
    })
  })

  it('denies when the asset is promoted to production after the gate, without new approvals', async () => {
    const db = await controlDb()
    // Approved as staging: no four eyes were required at the gate.
    await withRepo(db, (repo) => repo.assets.upsert(makeAsset({ environment: 'staging' })))
    // The asset moves to production before the run starts.
    await withRepo(db, (repo) => repo.assets.upsert(makeAsset({ environment: 'production' })))

    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })

    const execution = await executePlan(makePlan({ risk: 'destructive' }), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
      principalId: 'os:tester',
      authorization: AUTHORIZATION,
    })

    expect(execution.result.status).toBe('failed')
    expect(execution.result.error).toContain('production-destructive')
    expect(executor.calls).toHaveLength(0)
    await withRepo(db, async (repo) => {
      expect(await repo.plans.get(asPlanId('pln_test'))).toBeNull()
      expect(await repo.outbox.countByStatus('pending')).toBe(0)
    })
  })

  it('runs a production-destructive plan whose two approvals are still current', async () => {
    const db = await controlDb()
    await withRepo(db, async (repo) => {
      await repo.assets.upsert(makeAsset({ environment: 'production', protected: true }))
      await repo.approvals.record(makeApproval('alice', 'approve', iso(-1_000)))
      await repo.approvals.record(makeApproval('bob', 'approve', iso(-1_000)))
    })

    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump', '-Fc'], response: { stdout: 'ok' } })

    const execution = await executePlan(makePlan({ risk: 'destructive' }), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
      principalId: 'os:tester',
      authorization: AUTHORIZATION,
    })

    expect(execution.result.status).toBe('succeeded')
    expect(executor.calls).toHaveLength(1)
    await withRepo(db, async (repo) => {
      // The envelope records the risk the current asset justifies.
      expect((await repo.plans.get(asPlanId('pln_test')))?.payload.risk).toBe('production-destructive')
      expect((await repo.mandates.get(asMandateId('mnd_test')))?.allowedRisk).toBe(
        'production-destructive',
      )
    })
  })

  it('denies a destructive run without --yes', async () => {
    const db = await controlDb()
    await withRepo(db, (repo) => repo.assets.upsert(makeAsset({ environment: 'staging' })))
    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'ok' }) })

    const execution = await executePlan(makePlan({ risk: 'destructive' }), INSTANCE, {
      executor,
      writeError: () => {},
      controlDb: db,
      principalId: 'os:tester',
      authorization: { ...AUTHORIZATION, confirmed: false },
    })

    expect(execution.result.status).toBe('failed')
    expect(execution.result.error).toContain('--yes')
    expect(executor.calls).toHaveLength(0)
  })
})

describe('reportPlanOutcome', () => {
  it('writes the canonical summary and returns 0 on success', () => {
    const written: string[] = []
    const result = { planId: 'pln_test', status: 'succeeded' as const, steps: [] }
    const code = reportPlanOutcome(makePlan(), result, (text) => written.push(text))

    expect(code).toBe(0)
    const payload = JSON.parse(written.join('')) as {
      planId: string
      risk: string
      steps: string[]
      result: { status: string }
    }
    expect(payload.planId).toBe('pln_test')
    expect(payload.risk).toBe('reversible')
    expect(payload.steps).toEqual(['dump'])
    expect(payload.result.status).toBe('succeeded')
  })

  it('returns 1 on failure', () => {
    const result = { planId: 'pln_test', status: 'failed' as const, steps: [] }
    expect(reportPlanOutcome(makePlan(), result, () => {})).toBe(1)
  })
})
