import { describe, expect, it } from 'vitest'

import { FakeExecutor } from '../../src/testkit/fake-executor'

describe('FakeExecutor', () => {
  it('consumes rules FIFO and records calls', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['pg_dump'], response: { stdout: 'first' } })
    executor.enqueue({ match: ['pg_dump'], response: { stdout: 'second' } })

    expect((await executor.run(['pg_dump'])).stdout).toBe('first')
    expect((await executor.run(['pg_dump'])).stdout).toBe('second')
    expect(executor.calls).toHaveLength(2)
    expect(executor.calls[0]?.argv).toEqual(['pg_dump'])
  })

  it('matches by predicate', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: (cmd) => cmd[0] === 'psql',
      response: { exitCode: 1, stderr: 'boom' },
    })
    const result = await executor.run(['psql', '-c', 'select 1'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('boom')
  })

  it('fails loudly on an unmatched call', async () => {
    const executor = new FakeExecutor()
    await expect(executor.run(['unknown'])).rejects.toThrow(/no scripted response/)
  })

  it('supports a default handler', async () => {
    const executor = new FakeExecutor({ defaultHandler: () => ({ stdout: 'fallback' }) })
    expect((await executor.run(['anything'])).stdout).toBe('fallback')
  })

  it('yields scripted stream chunks', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({
      match: ['pg_dump'],
      response: {
        chunks: [
          { stream: 'stdout', text: 'a' },
          { stream: 'stdout', text: 'b' },
        ],
      },
    })
    const chunks: string[] = []
    for await (const chunk of executor.stream(['pg_dump'])) chunks.push(chunk.text)
    expect(chunks.join('')).toBe('ab')
  })

  it('models a timeout', async () => {
    const executor = new FakeExecutor()
    executor.enqueue({ match: ['slow'], response: { timedOut: true, exitCode: -1 } })
    const result = await executor.run(['slow'])
    expect(result.timedOut).toBe(true)
    expect(result.signal).toBe('SIGKILL')
  })
})
