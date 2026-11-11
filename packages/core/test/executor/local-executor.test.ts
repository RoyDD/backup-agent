import { describe, expect, it } from 'vitest'

import { LocalExecutor } from '../../src/executor/local-executor'
import { defineExecutorContractSuite } from '../contract/executor-contract.suite'

defineExecutorContractSuite('LocalExecutor', () => new LocalExecutor())

describe('LocalExecutor', () => {
  it('streams stdout chunks in order', async () => {
    const executor = new LocalExecutor()
    const chunks: string[] = []
    for await (const chunk of executor.stream([
      process.execPath,
      '-e',
      'process.stdout.write("a"); setTimeout(() => process.stdout.write("b"), 30)',
    ])) {
      chunks.push(chunk.text)
    }
    expect(chunks.join('')).toBe('ab')
  })

  it('reports a missing binary as exit code 127', async () => {
    const executor = new LocalExecutor()
    const result = await executor.run(['definitely-not-a-real-binary-bkagent'])
    expect(result.exitCode).toBe(127)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  it('honours an abort signal', async () => {
    const executor = new LocalExecutor()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const result = await executor.run(
      [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
      { signal: controller.signal },
    )
    expect(result.signal).toBe('SIGKILL')
  })
})
