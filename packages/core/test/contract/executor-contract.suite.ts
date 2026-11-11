import { describe, expect, it } from 'vitest'

import type { Executor } from '../../src/ports/executor'
import { classifyRunResult } from '../../src/executor/classify'

/**
 * Provider-side contract shared by every Executor implementation.
 * A new transport (ssh, kubectl) is only accepted once it passes these cases.
 */
export function defineExecutorContractSuite(
  name: string,
  factory: () => Promise<Executor> | Executor,
): void {
  describe(`Executor contract: ${name}`, () => {
    it('C-01 does not interpret argv through a shell', async () => {
      const executor = await factory()
      const literal = 'a; echo pwned'
      const result = await executor.run([
        process.execPath,
        '-e',
        'console.log(process.argv[1])',
        literal,
      ])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(literal)
    })

    it('C-02 preserves argv and passes env without leaking secrets', async () => {
      const executor = await factory()
      const argv = [process.execPath, '-e', 'console.log(process.env.BK_TEST ?? "missing")']
      const result = await executor.run(argv, { env: { BK_TEST: 'ok' } })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('ok')
      expect(result.argv).toEqual(argv)
    })

    it('C-03 classifies failures deterministically', () => {
      expect(
        classifyRunResult({ timedOut: true, signal: null, exitCode: -1, stderr: '' }),
      ).toBe('transient')
      expect(
        classifyRunResult({ timedOut: false, signal: null, exitCode: 1, stderr: 'FATAL: permission denied' }),
      ).toBe('manual')
      expect(
        classifyRunResult({
          timedOut: false,
          signal: null,
          exitCode: 1,
          stderr: 'ERROR: relation "x" does not exist SQL state: 42P01',
        }),
      ).toBe('permanent')
      expect(
        classifyRunResult({
          timedOut: false,
          signal: null,
          exitCode: 1,
          stderr: 'ERROR: could not connect SQL state: 08006',
        }),
      ).toBe('transient')
    })

    it('C-04 distinguishes a timeout from a normal failure', async () => {
      const executor = await factory()
      const result = await executor.run(
        [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
        { timeoutMs: 200 },
      )
      expect(result.timedOut).toBe(true)
      expect(result.signal).toBe('SIGKILL')
      expect(result.exitCode).not.toBe(0)
    })

    it('C-05 retains output produced before termination', async () => {
      const executor = await factory()
      const result = await executor.run(
        [process.execPath, '-e', 'process.stdout.write("partial"); setTimeout(() => {}, 5000)'],
        { timeoutMs: 300 },
      )
      expect(result.timedOut).toBe(true)
      expect(result.stdout).toContain('partial')
    })

    it('C-06 running the same command twice is equivalent', async () => {
      const executor = await factory()
      const argv = [process.execPath, '-e', 'console.log("same")']
      const first = await executor.run(argv)
      const second = await executor.run(argv)
      expect(second.exitCode).toBe(first.exitCode)
      expect(second.stdout).toBe(first.stdout)
    })

    it('C-07 reports a non-empty execution site', async () => {
      const executor = await factory()
      expect(executor.site.length).toBeGreaterThan(0)
      const result = await executor.run([process.execPath, '-e', 'console.log(1)'])
      expect(result.executionSite).toBe(executor.site)
    })
  })
}
