import { describe, expect, it } from 'vitest'

import type { StepAction } from '../../src/domain/action'
import { asGoalId, asGoalStepId, asMemoryId, asTargetId, type TargetId } from '../../src/domain/ids'
import type { MemoryEntry } from '../../src/ports/repository'
import { memoryEntryFor, recall } from '../../src/ops/memory'

const TARGET_A = asTargetId('target-a')
const TARGET_B = asTargetId('target-b')

function entry(options: {
  id: string
  signature: string
  targetId?: TargetId
  action?: StepAction
  state?: string
  error?: string | null
  success?: boolean
  createdAt?: string
}): MemoryEntry {
  const action: StepAction = options.action ?? { command: 'inspect', args: [] }
  const success = options.success ?? true
  const state = options.state ?? (success ? 'succeeded' : 'failed')
  return {
    memoryId: asMemoryId(options.id),
    targetId: options.targetId ?? TARGET_A,
    goalId: null,
    stepId: null,
    kind: 'outcome',
    signature: options.signature,
    action,
    outcome: {
      command: action.command,
      state,
      exitCode: success ? 0 : 1,
      error: options.error ?? null,
    },
    errorClass: success ? null : 'transient',
    success,
    createdAt: options.createdAt ?? '2026-03-01T00:00:00.000Z',
  }
}

describe('recall', () => {
  it('returns an empty list for an empty memory', () => {
    expect(recall([], {})).toEqual([])
  })

  it('ranks an exact signature match first', () => {
    const entries = [
      entry({ id: 'm-other', signature: 'other-signature' }),
      entry({ id: 'm-exact', signature: 'backup-failed' }),
    ]
    const hits = recall(entries, { signature: 'backup-failed' })
    expect(hits[0]?.entry.memoryId).toBe('m-exact')
    expect(hits[0]?.score).toBe(6)
  })

  it('ranks a same-target entry above an unrelated one', () => {
    const entries = [
      entry({ id: 'm-unrelated', signature: 'sig-b', targetId: TARGET_B, success: true }),
      entry({ id: 'm-target', signature: 'sig-a', targetId: TARGET_A, success: false }),
    ]
    const hits = recall(entries, { targetId: TARGET_A })
    expect(hits.map((hit) => hit.entry.memoryId)).toEqual(['m-target', 'm-unrelated'])
    expect(hits[0]?.score).toBe(3)
  })

  it('scores text overlap and drops entries with nothing in common', () => {
    const entries = [
      entry({ id: 'm-overlap', signature: 'connection refused', success: false }),
      entry({ id: 'm-unrelated', signature: 'disk full', success: false }),
    ]
    const hits = recall(entries, { text: 'connection refused during restore' })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.entry.memoryId).toBe('m-overlap')
    expect(hits[0]?.score).toBe(2)
  })

  it('caps the text-overlap contribution at three', () => {
    const entries = [
      entry({ id: 'm-many', signature: 'alpha beta gamma delta epsilon', success: false }),
    ]
    const hits = recall(entries, { text: 'alpha beta gamma delta epsilon' })
    expect(hits[0]?.score).toBe(3)
  })

  it('breaks score ties by recency and then by id', () => {
    const byRecency = [
      entry({ id: 'm-old', signature: 'sig', success: false, createdAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'm-new', signature: 'sig', success: false, createdAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(recall(byRecency, {}).map((hit) => hit.entry.memoryId)).toEqual(['m-new', 'm-old'])

    const byId = [
      entry({ id: 'm-b', signature: 'sig', success: false }),
      entry({ id: 'm-a', signature: 'sig', success: false }),
    ]
    expect(recall(byId, {}).map((hit) => hit.entry.memoryId)).toEqual(['m-a', 'm-b'])
  })

  it('defaults the limit to five and clamps an explicit one', () => {
    const entries = Array.from({ length: 7 }, (_, index) =>
      entry({
        id: `m-${index}`,
        signature: 'sig',
        success: false,
        createdAt: `2026-03-0${index + 1}T00:00:00.000Z`,
      }),
    )
    expect(recall(entries, {})).toHaveLength(5)
    expect(recall(entries, { limit: 2 })).toHaveLength(2)
    expect(recall(entries, { limit: 0 })).toHaveLength(1)
    expect(recall(entries, { limit: 999 })).toHaveLength(7)
  })

  it('returns everything ordered by recency for an empty query', () => {
    const entries = [
      entry({ id: 'm-1', signature: 'a', success: false, createdAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'm-2', signature: 'b', success: false, createdAt: '2026-03-01T00:00:00.000Z' }),
      entry({ id: 'm-3', signature: 'c', success: false, createdAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(recall(entries, {}).map((hit) => hit.entry.memoryId)).toEqual(['m-2', 'm-3', 'm-1'])
  })
})

describe('memoryEntryFor', () => {
  it('marks success only for a succeeded state', () => {
    const input = {
      memoryId: asMemoryId('m-1'),
      targetId: TARGET_A,
      goalId: asGoalId('goal-1'),
      stepId: asGoalStepId('step-1'),
      kind: 'outcome' as const,
      signature: 'inspect-ok',
      action: { command: 'inspect' as const, args: [] },
      state: 'succeeded',
      exitCode: 0,
      error: null,
      errorClass: null,
      createdAt: '2026-03-01T00:00:00.000Z',
    }
    expect(memoryEntryFor(input).success).toBe(true)
    expect(memoryEntryFor({ ...input, state: 'failed', exitCode: 1 }).success).toBe(false)
  })

  it('redacts a DSN password from the stored action', () => {
    const secret = 's3cret-pw'
    const built = memoryEntryFor({
      memoryId: asMemoryId('m-2'),
      targetId: TARGET_A,
      goalId: null,
      stepId: null,
      kind: 'outcome',
      signature: 'backup-failed',
      action: {
        command: 'backup',
        args: ['--dsn', `postgres://postgres:${secret}@db.example:5432/app`],
      },
      state: 'failed',
      exitCode: 1,
      error: 'connection refused',
      errorClass: 'transient',
      createdAt: '2026-03-01T00:00:00.000Z',
    })

    expect(built.action.args.join(' ')).toContain('***')
    expect(JSON.stringify(built)).not.toContain(secret)
    expect(built.outcome.command).toBe('backup')
    expect(built.outcome.error).toBe('connection refused')
  })
})
