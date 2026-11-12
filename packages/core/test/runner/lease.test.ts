import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RunOptions } from '../../src/ports/executor'
import type { Step } from '../../src/domain/plan'
import { runPlan } from '../../src/runner/run-plan'
import { FakeExecutor } from '../../src/testkit/fake-executor'
import { makePlan, makeStep } from '../fixtures/plan'

const sleep = async (): Promise<void> => undefined

function step(overrides: Partial<Step>): Step {
  return makeStep(overrides)
}

/** Executor that aborts the caller's signal once the command returns. */
class AbortAfterRunExecutor extends FakeExecutor {
  readonly seenSignals: Array<AbortSignal | undefined> = []

  constructor(private readonly controller: AbortController) {
    super()
  }

  override async run(cmd: readonly string[], opts: RunOptions = {}) {
    this.seenSignals.push(opts.signal)
    const result = await super.run(cmd, opts)
    // Simulates a heartbeat that lost the lease and killed the running command.
    this.controller.abort()
    return { ...result, exitCode: -1, signal: 'SIGKILL' }
  }
}

/** Executor that loses the lease while the command is running. */
class LosingExecutor extends FakeExecutor {
  lost = false

  override async run(cmd: readonly string[], opts: RunOptions = {}) {
    const result = await super.run(cmd, opts)
    this.lost = true
    return result
  }
}

describe('runPlan lease guard', () => {
  it('rejects before the first step when the guard reports a lost lease', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
    const plan = makePlan({ steps: [step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' })] })

    const result = await runPlan(plan, {
      executor,
      sleep,
      leaseGuard: () => false,
    })

    expect(result.status).toBe('lease-lost')
    expect(result.leaseLost?.phase).toBe('before-step')
    expect(result.leaseLost?.stepId).toBe('dump')
    expect(result.failedStep).toBeUndefined()
    expect(result.errorClass).toBeUndefined()
    expect(result.steps).toHaveLength(0)
    expect(executor.calls).toHaveLength(0)
  })

  it('reports a lease lost after execution instead of a failed attempt', async () => {
    const executor = new LosingExecutor()
    executor.enqueue({ match: ['dump'], response: { stdout: 'backup ok' } })
    const plan = makePlan({ steps: [step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' })] })

    const result = await runPlan(plan, {
      executor,
      sleep,
      leaseGuard: () => !executor.lost,
    })

    expect(result.status).toBe('lease-lost')
    expect(result.leaseLost?.phase).toBe('after-step')
    expect(result.errorClass).toBeUndefined()
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.status).toBe('lease-lost')
    expect(result.steps[0]?.errorClass).toBeUndefined()
    expect(result.steps[0]?.attempts).toBe(1)
    expect(result.steps[0]?.stdout).toBe('backup ok')
  })

  it('stops dispatching later steps once the lease is lost', async () => {
    const executor = new LosingExecutor()
    executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
    executor.enqueue({ match: ['verify'], response: { stdout: 'ok' } })
    const plan = makePlan({
      steps: [
        step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' }),
        step({ stepId: 'verify', argv: ['verify'], dependsOn: ['dump'], idempotencyKey: 'verify' }),
      ],
    })

    const result = await runPlan(plan, {
      executor,
      sleep,
      leaseGuard: () => !executor.lost,
    })

    expect(result.status).toBe('lease-lost')
    expect(result.steps.map((entry) => entry.stepId)).toEqual(['dump'])
    expect(executor.calls.map((call) => call.argv[0])).toEqual(['dump'])
  })

  it('passes the abort signal to the executor and reports an aborted command as lease-lost', async () => {
    const controller = new AbortController()
    const executor = new AbortAfterRunExecutor(controller)
    executor.enqueue({
      match: ['dump'],
      response: { delayMs: 5, stdout: 'partial', stderr: 'killed' },
    })
    const plan = makePlan({ steps: [step({ stepId: 'dump', argv: ['dump'], idempotencyKey: 'dump' })] })

    const result = await runPlan(plan, {
      executor,
      sleep,
      signal: controller.signal,
      leaseGuard: () => !controller.signal.aborted,
    })

    expect(executor.seenSignals).toEqual([controller.signal])
    expect(result.status).toBe('lease-lost')
    expect(result.leaseLost?.phase).toBe('after-step')
    expect(result.steps[0]?.status).toBe('lease-lost')
    expect(result.steps[0]?.exitCode).toBe(-1)
    expect(result.steps[0]?.stderr).toBe('killed')
    expect(executor.calls).toHaveLength(1)
  })

  it('does not retry an aborted command', async () => {
    const controller = new AbortController()
    const executor = new AbortAfterRunExecutor(controller)
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
            retryOn: ['transient', 'manual', 'permanent'],
          },
        }),
      ],
    })

    const result = await runPlan(plan, {
      executor,
      sleep,
      signal: controller.signal,
      leaseGuard: () => true,
    })

    expect(result.status).toBe('failed')
    expect(result.steps[0]?.attempts).toBe(1)
    expect(executor.calls).toHaveLength(1)
  })

  it('reports a lease lost during precondition evaluation before any dispatch', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
    let lost = false
    const plan = makePlan({
      steps: [
        step({
          stepId: 'dump',
          argv: ['dump'],
          idempotencyKey: 'dump',
          preconditions: [{ kind: 'custom', id: 'slow-check', params: {} }],
        }),
      ],
    })

    const result = await runPlan(plan, {
      executor,
      sleep,
      leaseGuard: () => !lost,
      customPredicates: {
        'slow-check': async () => {
          // The lease expires while the asynchronous check is in flight.
          await Promise.resolve()
          lost = true
          return true
        },
      },
    })

    expect(result.status).toBe('lease-lost')
    expect(result.leaseLost?.phase).toBe('before-step')
    expect(result.leaseLost?.stepId).toBe('dump')
    expect(result.failedStep).toBeUndefined()
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.status).toBe('lease-lost')
    expect(result.steps[0]?.attempts).toBe(0)
    expect(executor.calls).toHaveLength(0)
  })

  it('reports a lease lost during postcondition evaluation instead of success', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'bk-lease-post-'))
    try {
      const executor = new FakeExecutor()
      executor.enqueue({ match: ['dump'], response: { stdout: 'backup ok' } })
      let lost = false
      const plan = makePlan({
        steps: [
          step({
            stepId: 'dump',
            argv: ['dump'],
            idempotencyKey: 'dump',
            postconditions: [{ kind: 'custom', id: 'slow-verify', params: {} }],
          }),
        ],
      })

      const result = await runPlan(plan, {
        executor,
        sleep,
        stateDir,
        leaseGuard: () => !lost,
        customPredicates: {
          'slow-verify': async () => {
            await Promise.resolve()
            lost = true
            return true
          },
        },
      })

      expect(result.status).toBe('lease-lost')
      expect(result.leaseLost?.phase).toBe('after-step')
      expect(result.steps[0]?.status).toBe('lease-lost')
      expect(result.steps[0]?.exitCode).toBe(0)
      expect(result.steps[0]?.stdout).toBe('backup ok')
      expect(result.failedStep).toBeUndefined()
      // The step must not be checkpointed as completed after the lease was lost.
      const checkpoint = JSON.parse(
        readFileSync(join(stateDir, `${plan.planId}.json`), 'utf8'),
      ) as { completed: string[] }
      expect(checkpoint.completed).toEqual([])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('reports a lease lost during postcondition evaluation of a write-file step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-lease-write-'))
    try {
      const path = join(dir, 'recovery.conf')
      let lost = false
      const plan = makePlan({
        steps: [
          step({
            stepId: 'write',
            kind: 'write-file',
            argv: undefined,
            file: { path, content: 'x\n' },
            idempotencyKey: 'write',
            postconditions: [{ kind: 'custom', id: 'slow-verify', params: {} }],
          }),
        ],
      })

      const result = await runPlan(plan, {
        executor: new FakeExecutor(),
        sleep,
        stateDir: dir,
        leaseGuard: () => !lost,
        customPredicates: {
          'slow-verify': async () => {
            await Promise.resolve()
            lost = true
            return true
          },
        },
      })

      expect(result.status).toBe('lease-lost')
      expect(result.leaseLost?.phase).toBe('after-step')
      expect(result.steps[0]?.status).toBe('lease-lost')
      expect(result.steps[0]?.attempts).toBe(1)
      expect(readFileSync(path, 'utf8')).toBe('x\n')
      const checkpoint = JSON.parse(
        readFileSync(join(dir, `${plan.planId}.json`), 'utf8'),
      ) as { completed: string[] }
      expect(checkpoint.completed).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a lease lost during retry backoff before re-dispatch', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: ['dump'],
      response: { exitCode: 1, stderr: 'could not connect to server' },
    })
    executor.enqueue({ match: ['dump'], response: { stdout: 'ok' } })
    let lost = false
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

    const result = await runPlan(plan, {
      executor,
      leaseGuard: () => !lost,
      sleep: async () => {
        // The lease expires while the runner waits out the backoff.
        lost = true
      },
    })

    expect(result.status).toBe('lease-lost')
    expect(result.leaseLost?.phase).toBe('before-retry')
    expect(result.steps[0]?.status).toBe('lease-lost')
    expect(result.steps[0]?.attempts).toBe(1)
    expect(result.steps[0]?.stderr).toBe('could not connect to server')
    expect(result.errorClass).toBeUndefined()
    // The retry was never dispatched and no later step ran.
    expect(executor.calls).toHaveLength(1)
  })
})
