import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { redactAction } from '../../src/domain/action'
import type { Goal, GoalStep } from '../../src/domain/goal'
import {
  asGoalId,
  asGoalStepId,
  asMemoryId,
  asPlanId,
  asStepAttemptId,
  asTargetId,
} from '../../src/domain/ids'
import type { Diagnosis } from '../../src/domain/remediation'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import type { MemoryEntry, Repository, StepAttemptRecord } from '../../src/ports/repository'

const NOW = '2026-01-01T01:00:00.000Z'

let repo: Repository | undefined
const dirs: string[] = []

afterEach(async () => {
  await repo?.close()
  repo = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function open(): Promise<Repository> {
  const created = await createSqliteRepository({ filename: ':memory:' })
  await created.migrate()
  repo = created
  return created
}

async function openFile(): Promise<{ repo: Repository; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'bk-goals-'))
  dirs.push(dir)
  const file = join(dir, 'control.db')
  const created = await createSqliteRepository({ filename: file })
  await created.migrate()
  repo = created
  return { repo: created, file }
}

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    goalId: asGoalId('gol_1'),
    principalId: 'os:roy',
    targetId: asTargetId('pg-prod'),
    intent: 'restore the nightly backup',
    state: 'open',
    constraints: { maxSteps: 5, maxStepAttempts: 2, maxGoalAttempts: 4, allowDestructive: true },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function step(overrides: Partial<GoalStep> = {}): GoalStep {
  return {
    stepId: asGoalStepId('stp_1'),
    goalId: asGoalId('gol_1'),
    ordinal: 0,
    intent: 'inspect the target before touching it',
    action: { command: 'inspect', args: ['--dsn', 'postgres://h/db'] },
    dependsOn: [],
    state: 'pending',
    attempts: 0,
    maxAttempts: 2,
    planId: null,
    approvedBy: null,
    approvedAt: null,
    lastErrorClass: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function attempt(overrides: Partial<StepAttemptRecord> = {}): StepAttemptRecord {
  return {
    attemptId: asStepAttemptId('sat_1'),
    stepId: asGoalStepId('stp_1'),
    attempt: 1,
    planId: null,
    state: 'running',
    exitCode: null,
    errorClass: null,
    signature: null,
    action: { command: 'inspect', args: ['--dsn', 'postgres://h/db'] },
    diagnosis: null,
    startedAt: NOW,
    finishedAt: null,
    ...overrides,
  }
}

function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    memoryId: asMemoryId('mem_1'),
    targetId: asTargetId('pg-prod'),
    goalId: asGoalId('gol_1'),
    stepId: asGoalStepId('stp_1'),
    kind: 'outcome',
    signature: 'connect:timeout',
    action: { command: 'inspect', args: ['--dsn', 'postgres://h/db'] },
    outcome: { command: 'inspect', state: 'failed', exitCode: 2, error: 'timeout' },
    errorClass: 'transient',
    success: false,
    createdAt: NOW,
    ...overrides,
  }
}

const DIAGNOSIS: Diagnosis = {
  stepId: asGoalStepId('stp_1'),
  errorClass: 'transient',
  signature: 'connect:timeout',
  exitCode: 2,
  attempts: 1,
  maxAttempts: 2,
  candidates: [
    { kind: 'retry', reason: 'transient', requiresAction: false },
    { kind: 'escalate', reason: 'human decides', requiresAction: false },
  ],
  requiresHuman: false,
}

describe('goal persistence', () => {
  it('round-trips a goal including its constraints and state', async () => {
    const r = await open()
    await r.goals.insert(goal())

    const stored = await r.goals.get(asGoalId('gol_1'))
    expect(stored).not.toBeNull()
    expect(stored?.intent).toBe('restore the nightly backup')
    expect(stored?.principalId).toBe('os:roy')
    expect(stored?.state).toBe('open')
    // Limits are re-read on every step, so they must survive the JSON column.
    expect(stored?.constraints).toEqual({
      maxSteps: 5,
      maxStepAttempts: 2,
      maxGoalAttempts: 4,
      allowDestructive: true,
    })

    await r.goals.updateState(asGoalId('gol_1'), 'running', '2026-01-01T02:00:00.000Z')
    const moved = await r.goals.get(asGoalId('gol_1'))
    expect(moved?.state).toBe('running')
    expect(moved?.updatedAt).toBe('2026-01-01T02:00:00.000Z')
    expect(moved?.createdAt).toBe(NOW)
  })

  it('filters goals by state and target, newest first, with a limit', async () => {
    const r = await open()
    await r.goals.insert(goal({ goalId: asGoalId('gol_old'), createdAt: '2026-01-01T00:00:00.000Z' }))
    await r.goals.insert(
      goal({
        goalId: asGoalId('gol_new'),
        state: 'running',
        createdAt: '2026-01-01T03:00:00.000Z',
      }),
    )
    await r.goals.insert(
      goal({
        goalId: asGoalId('gol_other'),
        targetId: asTargetId('pg-stage'),
        state: 'running',
        createdAt: '2026-01-01T02:00:00.000Z',
      }),
    )

    const running = await r.goals.list({ state: 'running' })
    expect(running.map((row) => row.goalId)).toEqual([asGoalId('gol_new'), asGoalId('gol_other')])

    const onProd = await r.goals.list({ targetId: asTargetId('pg-prod') })
    expect(onProd.map((row) => row.goalId)).toEqual([asGoalId('gol_new'), asGoalId('gol_old')])

    const limited = await r.goals.list({ limit: 2 })
    expect(limited.map((row) => row.goalId)).toEqual([asGoalId('gol_new'), asGoalId('gol_other')])
  })
})

describe('goal step persistence', () => {
  it('round-trips steps with dependsOn and patches without erasing columns', async () => {
    const r = await open()
    await r.goals.insert(goal())
    await r.goals.insert(goal({ goalId: asGoalId('gol_2'), intent: 'second' }))
    await r.goalSteps.insert(step({ ordinal: 0, dependsOn: [] }))
    await r.goalSteps.insert(
      step({
        stepId: asGoalStepId('stp_2'),
        ordinal: 1,
        dependsOn: [asGoalStepId('stp_1'), asGoalStepId('stp_0')],
        approvedBy: 'alice',
        approvedAt: '2026-01-01T01:30:00.000Z',
      }),
    )

    const first = await r.goalSteps.get(asGoalStepId('stp_1'))
    expect(first?.dependsOn).toEqual([])
    const second = await r.goalSteps.get(asGoalStepId('stp_2'))
    expect(second?.dependsOn).toEqual([asGoalStepId('stp_1'), asGoalStepId('stp_0')])
    expect(second?.action).toEqual({ command: 'inspect', args: ['--dsn', 'postgres://h/db'] })

    const listed = await r.goalSteps.listByGoal(asGoalId('gol_1'))
    expect(listed.map((row) => row.ordinal)).toEqual([0, 1])

    await r.goalSteps.update(asGoalStepId('stp_2'), { state: 'ready' }, '2026-01-01T02:00:00.000Z')
    const patched = await r.goalSteps.get(asGoalStepId('stp_2'))
    expect(patched?.state).toBe('ready')
    expect(patched?.updatedAt).toBe('2026-01-01T02:00:00.000Z')
    // Everything the patch did not name keeps its stored value.
    expect(patched?.dependsOn).toEqual([asGoalStepId('stp_1'), asGoalStepId('stp_0')])
    expect(patched?.approvedBy).toBe('alice')
    expect(patched?.approvedAt).toBe('2026-01-01T01:30:00.000Z')
    expect(patched?.attempts).toBe(0)
    expect(patched?.maxAttempts).toBe(2)
    expect(patched?.intent).toBe('inspect the target before touching it')

    // A patch may clear an approval, which is different from omitting it.
    await r.goalSteps.update(asGoalStepId('stp_2'), { approvedBy: null, approvedAt: null }, NOW)
    const cleared = await r.goalSteps.get(asGoalStepId('stp_2'))
    expect(cleared?.approvedBy).toBeNull()
    expect(cleared?.approvedAt).toBeNull()
  })

  it('rejects an unknown step id and a repeated ordinal', async () => {
    const r = await open()
    await r.goals.insert(goal())
    await r.goalSteps.insert(step({ ordinal: 0 }))

    await expect(
      r.goalSteps.insert(step({ stepId: asGoalStepId('stp_dup'), ordinal: 0 })),
    ).rejects.toThrow()

    await expect(r.goalSteps.update(asGoalStepId('stp_missing'), { state: 'ready' }, NOW)).rejects.toThrow(
      'goal step not found',
    )
  })

  it('deletes only pending steps on a replan', async () => {
    const r = await open()
    await r.goals.insert(goal())
    await r.goalSteps.insert(step({ stepId: asGoalStepId('stp_done'), ordinal: 0, state: 'succeeded' }))
    await r.goalSteps.insert(step({ stepId: asGoalStepId('stp_pending_a'), ordinal: 1 }))
    await r.goalSteps.insert(step({ stepId: asGoalStepId('stp_pending_b'), ordinal: 2 }))

    expect(await r.goalSteps.deletePending(asGoalId('gol_1'))).toBe(2)
    const left = await r.goalSteps.listByGoal(asGoalId('gol_1'))
    expect(left.map((row) => row.stepId)).toEqual([asGoalStepId('stp_done')])
    expect(await r.goalSteps.deletePending(asGoalId('gol_1'))).toBe(0)
  })
})

describe('cascade deletes', () => {
  it('removes steps and their attempts when the goal row is deleted', async () => {
    const { repo: r, file } = await openFile()
    await r.goals.insert(goal())
    await r.goalSteps.insert(step())
    await r.stepAttempts.insert(attempt())

    // No delete API exists on purpose: the cascade is exercised on the raw
    // table, which is how an operator purge or a future migration would do it.
    await r.close()
    repo = undefined
    const raw = new DatabaseSync(file)
    try {
      raw.exec('PRAGMA foreign_keys = ON')
      raw.prepare('DELETE FROM goals WHERE id = ?').run('gol_1')
      const steps = raw.prepare('SELECT COUNT(*) AS count FROM goal_steps').get() as { count: number }
      const attempts = raw.prepare('SELECT COUNT(*) AS count FROM step_attempts').get() as {
        count: number
      }
      expect(steps.count).toBe(0)
      expect(attempts.count).toBe(0)
    } finally {
      raw.close()
    }
  })
})

describe('step attempt persistence', () => {
  it('round-trips attempts with and without a diagnosis, ordered by attempt', async () => {
    const r = await open()
    await r.goals.insert(goal())
    await r.goalSteps.insert(step())
    await r.stepAttempts.insert(attempt({ attemptId: asStepAttemptId('sat_2'), attempt: 2 }))
    await r.stepAttempts.insert(
      attempt({
        attemptId: asStepAttemptId('sat_1'),
        attempt: 1,
        planId: asPlanId('pln_1'),
        state: 'failed',
        exitCode: 2,
        errorClass: 'transient',
        signature: 'connect:timeout',
        diagnosis: DIAGNOSIS,
        finishedAt: '2026-01-01T01:05:00.000Z',
      }),
    )

    const withoutDiagnosis = await r.stepAttempts.get(asStepAttemptId('sat_2'))
    expect(withoutDiagnosis?.diagnosis).toBeNull()
    expect(withoutDiagnosis?.signature).toBeNull()
    expect(withoutDiagnosis?.exitCode).toBeNull()

    const withDiagnosis = await r.stepAttempts.get(asStepAttemptId('sat_1'))
    expect(withDiagnosis?.diagnosis).toEqual(DIAGNOSIS)
    expect(withDiagnosis?.planId).toBe(asPlanId('pln_1'))
    expect(withDiagnosis?.state).toBe('failed')
    expect(withDiagnosis?.finishedAt).toBe('2026-01-01T01:05:00.000Z')

    const ordered = await r.stepAttempts.listByStep(asGoalStepId('stp_1'))
    expect(ordered.map((row) => row.attempt)).toEqual([1, 2])

    // The diagnosis is written after the fact, so the update must land in place.
    await r.stepAttempts.setDiagnosis(asStepAttemptId('sat_2'), DIAGNOSIS)
    expect((await r.stepAttempts.get(asStepAttemptId('sat_2')))?.diagnosis).toEqual(DIAGNOSIS)
  })
})

describe('memory persistence', () => {
  it('appends entries and reads them newest first', async () => {
    const r = await open()
    await r.memory.append(
      memoryEntry({ memoryId: asMemoryId('mem_old'), createdAt: '2026-01-01T00:00:00.000Z' }),
    )
    await r.memory.append(
      memoryEntry({
        memoryId: asMemoryId('mem_new'),
        signature: 'connect:refused',
        kind: 'lesson',
        success: true,
        errorClass: null,
        outcome: { command: 'inspect', state: 'succeeded', exitCode: 0, error: null },
        createdAt: '2026-01-01T03:00:00.000Z',
      }),
    )

    const all = await r.memory.list()
    expect(all.map((entry) => entry.memoryId)).toEqual([asMemoryId('mem_new'), asMemoryId('mem_old')])

    const newest = all[0]
    expect(newest?.kind).toBe('lesson')
    expect(newest?.success).toBe(true)
    expect(newest?.errorClass).toBeNull()
    expect(newest?.outcome).toEqual({
      command: 'inspect',
      state: 'succeeded',
      exitCode: 0,
      error: null,
    })
    expect(newest?.action).toEqual({ command: 'inspect', args: ['--dsn', 'postgres://h/db'] })

    // `false` survives the INTEGER column, not just `true`.
    const oldest = all[1]
    expect(oldest?.success).toBe(false)
    expect(oldest?.errorClass).toBe('transient')
    expect(oldest?.outcome.error).toBe('timeout')
    expect(oldest?.goalId).toBe(asGoalId('gol_1'))
    expect(oldest?.stepId).toBe(asGoalStepId('stp_1'))
  })

  it('filters memory by signature and target, with a limit', async () => {
    const r = await open()
    await r.memory.append(memoryEntry({ memoryId: asMemoryId('mem_a') }))
    await r.memory.append(
      memoryEntry({
        memoryId: asMemoryId('mem_b'),
        signature: 'connect:refused',
        createdAt: '2026-01-01T02:00:00.000Z',
      }),
    )
    await r.memory.append(
      memoryEntry({
        memoryId: asMemoryId('mem_c'),
        targetId: asTargetId('pg-stage'),
        createdAt: '2026-01-01T03:00:00.000Z',
      }),
    )

    const bySignature = await r.memory.list({ signature: 'connect:refused' })
    expect(bySignature.map((entry) => entry.memoryId)).toEqual([asMemoryId('mem_b')])

    const onProd = await r.memory.list({ targetId: asTargetId('pg-prod') })
    expect(onProd.map((entry) => entry.memoryId)).toEqual([asMemoryId('mem_b'), asMemoryId('mem_a')])

    const limited = await r.memory.list({ limit: 1 })
    expect(limited.map((entry) => entry.memoryId)).toEqual([asMemoryId('mem_c')])
  })

  it('stores no plaintext password once the caller redacted the action', async () => {
    const { repo: r, file } = await openFile()
    const action = { command: 'inspect' as const, args: ['--dsn', 'postgres://dba:s3cret@h/db'] }
    await r.memory.append(
      memoryEntry({
        action: redactAction(action),
        outcome: { command: 'inspect', state: 'succeeded', exitCode: 0, error: null },
        success: true,
        errorClass: null,
      }),
    )

    const readBack = await r.memory.list()
    expect(readBack[0]?.action.args).toEqual(['--dsn', 'postgres://dba:***@h/db'])

    await r.close()
    repo = undefined
    const raw = new DatabaseSync(file)
    try {
      const row = raw.prepare('SELECT action_json FROM memory_entries').get() as {
        action_json: string
      }
      expect(row.action_json).not.toContain('s3cret')
      expect(row.action_json).toContain('***')
    } finally {
      raw.close()
    }
  })
})
