import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Step } from '../../src/domain/plan'
import { runPlan } from '../../src/runner/run-plan'
import { FakeExecutor } from '../../src/testkit/fake-executor'
import { makePlan, makeStep } from '../fixtures/plan'

const sleep = async (): Promise<void> => undefined

function cleanupStep(overrides: Partial<Step> = {}): Step {
  return makeStep({
    stepId: 'stop-instance',
    argv: ['stop', '-m', 'fast'],
    idempotencyKey: 'cleanup-stop',
    checkpoint: 'after',
    retry: {
      maxAttempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
      backoff: 'none',
      retryOn: ['transient'],
    },
    ...overrides,
  })
}

describe('runPlan cleanup graph', () => {
  it('runs cleanup after a failed step and keeps the original failure', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { exitCode: 2, stderr: 'boom' } })
    executor.enqueue({ match: ['stop', '-m', 'fast'], response: { stdout: 'stopped' } })
    const plan = makePlan({
      steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
      cleanup: [cleanupStep()],
    })

    const result = await runPlan(plan, { executor, sleep })

    expect(result.status).toBe('failed')
    expect(result.failedStep).toBe('dump')
    expect(result.error).toBe('step failed')
    expect(result.cleanup).toHaveLength(1)
    expect(result.cleanup?.[0]?.stepId).toBe('stop-instance')
    expect(result.cleanup?.[0]?.status).toBe('succeeded')
    expect(result.cleanupFailed).toBeUndefined()
    expect(executor.calls.map((call) => call.argv[0])).toEqual(['dump', 'stop'])
  })

  it('does not run cleanup when the plan succeeds', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
    const plan = makePlan({
      steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
      cleanup: [cleanupStep()],
    })

    const result = await runPlan(plan, { executor, sleep })

    expect(result.status).toBe('succeeded')
    expect(result.cleanup).toBeUndefined()
    expect(executor.calls.map((call) => call.argv[0])).toEqual(['dump'])
  })

  it('skips a cleanup step whose precondition no longer holds', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { exitCode: 2, stderr: 'boom' } })
    const plan = makePlan({
      steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
      cleanup: [
        cleanupStep({
          // The server already went away, so there is nothing to stop.
          preconditions: [{ kind: 'fileExists', path: '/nonexistent/bkagent/postmaster.pid' }],
        }),
      ],
    })

    const result = await runPlan(plan, { executor, sleep })

    expect(result.cleanup?.[0]?.status).toBe('skipped')
    expect(executor.calls.map((call) => call.argv[0])).toEqual(['dump'])
  })

  it('reports a cleanup failure without replacing the original error', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { exitCode: 2, stderr: 'boom' } })
    executor.enqueue({ match: ['stop', '-m', 'fast'], response: { exitCode: 1, stderr: 'no server' } })
    executor.enqueue({ match: ['stop', '-m', 'fast'], response: { exitCode: 1, stderr: 'no server' } })
    const plan = makePlan({
      steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
      cleanup: [cleanupStep()],
    })

    const result = await runPlan(plan, { executor, sleep })

    expect(result.status).toBe('failed')
    expect(result.failedStep).toBe('dump')
    expect(result.error).toBe('step failed')
    expect(result.cleanupFailed).toEqual(['stop-instance'])
    // A permanent cleanup error is not retried, and still does not replace the
    // failure that triggered cleanup.
    expect(result.cleanup?.[0]?.attempts).toBe(1)
  })

  it('runs later cleanup steps even when an earlier one failed', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { exitCode: 2, stderr: 'boom' } })
    executor.enqueue({ match: ['stop', '-m', 'fast'], response: { exitCode: 1, stderr: 'nope' } })
    executor.enqueue({ match: ['stop', '-m', 'fast'], response: { exitCode: 1, stderr: 'nope' } })
    executor.enqueue({ match: ['rm-signal'], response: {} })
    const plan = makePlan({
      steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
      cleanup: [
        cleanupStep(),
        cleanupStep({ stepId: 'remove-signal', argv: ['rm-signal'], idempotencyKey: 'cleanup-signal' }),
      ],
    })

    const result = await runPlan(plan, { executor, sleep })

    expect(result.cleanup?.map((outcome) => [outcome.stepId, outcome.status])).toEqual([
      ['stop-instance', 'failed'],
      ['remove-signal', 'succeeded'],
    ])
    expect(result.cleanupFailed).toEqual(['stop-instance'])
  })

  it('retries a transient cleanup failure and succeeds', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { exitCode: 2, stderr: 'boom' } })
    executor.enqueue({
      match: ['stop', '-m', 'fast'],
      response: { exitCode: 1, stderr: 'could not connect' },
    })
    executor.enqueue({ match: ['stop', '-m', 'fast'], response: { stdout: 'stopped' } })
    const plan = makePlan({
      steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
      cleanup: [cleanupStep()],
    })

    const result = await runPlan(plan, { executor, sleep })

    expect(result.cleanup?.[0]?.status).toBe('succeeded')
    expect(result.cleanup?.[0]?.attempts).toBe(2)
  })

  it('stops cleanup when the lease is lost at the failure boundary', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { exitCode: 2, stderr: 'boom' } })

    let checks = 0
    const result = await runPlan(makePlan({
      steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
      cleanup: [cleanupStep()],
    }), {
      executor,
      sleep,
      leaseGuard: () => {
        checks += 1
        // Probes 1-3 bracket the main step (before, after preconditions, after
        // the command); probe 4 is the cleanup boundary and reports the loss.
        return checks <= 3
      },
    })

    expect(result.status).toBe('failed')
    expect(result.cleanup?.map((outcome) => outcome.status)).toEqual(['lease-lost'])
    expect(executor.calls.map((call) => call.argv[0])).toEqual(['dump'])
  })

  it('executes a write-file cleanup step after a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bkagent-cleanup-'))
    try {
      const target = join(dir, 'recovery.signal')
      writeFileSync(target, '')
      const executor = new FakeExecutor()
      executor.enqueue({ match: ['dump'], response: { exitCode: 2, stderr: 'boom' } })
      const plan = makePlan({
        steps: [makeStep({ argv: ['dump'], idempotencyKey: 'dump' })],
        cleanup: [
          cleanupStep({
            stepId: 'write-cleanup-note',
            kind: 'write-file',
            argv: undefined,
            file: { path: join(dir, 'cleanup.txt'), content: 'stopped\n' },
            idempotencyKey: 'cleanup-file',
          }),
        ],
      })

      const result = await runPlan(plan, { executor, sleep })

      expect(result.cleanup?.[0]?.status).toBe('succeeded')
      expect(existsSync(join(dir, 'cleanup.txt'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
