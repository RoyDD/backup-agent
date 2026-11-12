import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Step } from '../../src/domain/plan'
import { runPlan, topologicalOrder } from '../../src/runner/run-plan'
import { FakeExecutor } from '../../src/testkit/fake-executor'
import { makePlan, makeStep } from '../fixtures/plan'

const sleep = async (): Promise<void> => undefined

function step(overrides: Partial<Step>): Step {
  return makeStep(overrides)
}

describe('topologicalOrder', () => {
  it('orders dependencies before dependents', () => {
    const a = step({ stepId: 'a', idempotencyKey: 'a' })
    const b = step({ stepId: 'b', dependsOn: ['a'], idempotencyKey: 'b' })
    expect(topologicalOrder([b, a]).map((entry) => entry.stepId)).toEqual(['a', 'b'])
  })
})

describe('runPlan', () => {
  it('executes steps and records outcomes', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
    executor.enqueue({ match: ['verify'], response: { stdout: 'ok' } })

    const plan = makePlan({
      steps: [
        step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' }),
        step({
          stepId: 'verify',
          argv: ['verify'],
          dependsOn: ['dump'],
          idempotencyKey: 'verify',
        }),
      ],
    })

    const result = await runPlan(plan, { executor, sleep })
    expect(result.status).toBe('succeeded')
    expect(result.steps.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded'])
    expect(executor.calls.map((call) => call.argv[0])).toEqual(['dump', 'verify'])
  })

  it('fails before execution when a precondition does not hold', async () => {
    const executor = new FakeExecutor()
    const plan = makePlan({
      steps: [
        step({
          stepId: 'dump',
          argv: ['dump'],
          idempotencyKey: 'dump',
          preconditions: [{ kind: 'fileExists', path: '/definitely/not/here' }],
        }),
      ],
    })

    const result = await runPlan(plan, { executor, sleep })
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('permanent')
    expect(executor.calls).toHaveLength(0)
  })

  it('retries transient failures with the step policy', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: ['dump'],
      response: { exitCode: 1, stderr: 'ERROR: canceling statement due to statement timeout' },
    })
    executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })

    const plan = makePlan({
      steps: [
        step({
          stepId: 'dump',
          argv: ['dump'],
          idempotencyKey: 'dump',
          retry: {
            maxAttempts: 3,
            initialDelayMs: 1,
            maxDelayMs: 1,
            backoff: 'none',
            retryOn: ['transient'],
          },
        }),
      ],
    })

    const result = await runPlan(plan, { executor, sleep })
    expect(result.status).toBe('succeeded')
    expect(result.steps[0]?.attempts).toBe(2)
  })

  it('does not retry permanent failures', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: ['dump'],
      response: { exitCode: 1, stderr: 'FATAL: database "ghost" does not exist' },
    })

    const plan = makePlan({
      steps: [step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' })],
    })

    const result = await runPlan(plan, { executor, sleep })
    expect(result.status).toBe('failed')
    expect(result.errorClass).toBe('permanent')
    expect(result.steps[0]?.attempts).toBe(1)
  })

  it('skips checkpointed steps when resuming', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bk-state-'))
    try {
      const plan = makePlan({
        planId: 'pln_resume' as never,
        steps: [step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' })],
      })
      const first = new FakeExecutor()
      first.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
      expect((await runPlan(plan, { executor: first, stateDir, sleep })).status).toBe('succeeded')

      const second = new FakeExecutor()
      const resumed = await runPlan(plan, { executor: second, stateDir, resume: true, sleep })
      expect(resumed.status).toBe('succeeded')
      expect(resumed.steps[0]?.status).toBe('skipped')
      expect(second.calls).toHaveLength(0)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('re-runs a checkpoint:none step on resume', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bk-state-'))
    try {
      const plan = makePlan({
        planId: 'pln_resume_none' as never,
        steps: [
          step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump', checkpoint: 'none' }),
        ],
      })
      const first = new FakeExecutor()
      first.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
      await runPlan(plan, { executor: first, stateDir, sleep })

      const second = new FakeExecutor()
      second.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
      const resumed = await runPlan(plan, { executor: second, stateDir, resume: true, sleep })
      expect(resumed.status).toBe('succeeded')
      expect(resumed.steps[0]?.status).toBe('succeeded')
      expect(second.calls).toHaveLength(1)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('re-runs a checkpoint:before step on resume', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bk-state-'))
    try {
      const plan = makePlan({
        planId: 'pln_resume_before' as never,
        steps: [
          step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump', checkpoint: 'before' }),
        ],
      })
      const first = new FakeExecutor()
      first.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
      await runPlan(plan, { executor: first, stateDir, sleep })

      const second = new FakeExecutor()
      second.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
      const resumed = await runPlan(plan, { executor: second, stateDir, resume: true, sleep })
      expect(resumed.steps[0]?.status).toBe('succeeded')
      expect(second.calls).toHaveLength(1)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('includes stdout and stderr in failed outcomes', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: ['dump'],
      response: { exitCode: 1, stdout: 'partial', stderr: 'boom' },
    })
    const plan = makePlan({ steps: [step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' })] })
    const result = await runPlan(plan, { executor, sleep })
    expect(result.steps[0]?.stdout).toBe('partial')
    expect(result.steps[0]?.stderr).toBe('boom')
  })

  it('evaluates file preconditions against the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-cwd-'))
    try {
      writeFileSync(join(dir, 'marker'), 'x')
      const executor = new FakeExecutor()
      executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
      const plan = makePlan({
        steps: [
          step({
            stepId: 'dump',
            argv: ['dump'],
            idempotencyKey: 'dump',
            preconditions: [{ kind: 'fileExists', path: 'marker' }],
          }),
        ],
      })
      const result = await runPlan(plan, { executor, cwd: dir, sleep })
      expect(result.status).toBe('succeeded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes files for write-file steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-write-'))
    try {
      const path = join(dir, 'recovery.conf')
      const plan = makePlan({
        steps: [
          step({
            stepId: 'write',
            kind: 'write-file',
            argv: undefined,
            file: { path, content: 'restore_command = \'cp /w/%f %p\'\n', mode: 0o600 },
            idempotencyKey: 'write',
          }),
        ],
      })
      const result = await runPlan(plan, { executor: new FakeExecutor(), sleep })
      expect(result.status).toBe('succeeded')
      expect(readFileSync(path, 'utf8')).toContain('restore_command')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
