import { describe, expect, it } from 'vitest'

import { KubectlExecutor } from '../../src/executor/kubectl-executor'
import { RemoteExecutorError } from '../../src/executor/posix-quote'
import { createRecorder } from './fake-transport-child'

function makeExecutor(
  recorder = createRecorder(),
  overrides: Partial<ConstructorParameters<typeof KubectlExecutor>[0]> = {},
): { executor: KubectlExecutor; recorder: ReturnType<typeof createRecorder> } {
  const executor = new KubectlExecutor({
    pod: 'db-0',
    spawnImpl: recorder.spawnImpl,
    ...overrides,
  })
  return { executor, recorder }
}

describe('KubectlExecutor argv', () => {
  it('places every option before the pod and the command after --', () => {
    const executor = new KubectlExecutor({
      pod: 'db-0',
      namespace: 'pg',
      container: 'postgres',
      context: 'prod-eu',
      kubeconfig: '/etc/kube/config',
    })
    expect(executor.buildArgv(['pgbackrest', '--stanza=main', 'backup'])).toEqual([
      'kubectl',
      'exec',
      '--namespace=pg',
      '--context=prod-eu',
      '--kubeconfig=/etc/kube/config',
      'db-0',
      '--container=postgres',
      '--',
      'pgbackrest',
      '--stanza=main',
      'backup',
    ])
  })

  it('omits unset options and still emits --', () => {
    const { executor } = makeExecutor()
    expect(executor.buildArgv(['true'])).toEqual(['kubectl', 'exec', 'db-0', '--', 'true'])
    expect(executor.site).toBe('kubectl:default/db-0')
  })

  it('reports the namespace and pod in the execution site', () => {
    const { executor } = makeExecutor(undefined, { namespace: 'pg', pod: 'db-1' })
    expect(executor.site).toBe('kubectl:pg/db-1')
  })

  it('passes the command as argv, never as a shell string', () => {
    const { executor } = makeExecutor()
    const argv = executor.buildArgv(['printf', '%s', 'a; echo pwned'])
    // Everything after `--` is a separate element: kubectl forwards argv, so
    // the payload never becomes shell syntax on the far side.
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['printf', '%s', 'a; echo pwned'])
    expect(argv.filter((arg) => arg.includes('echo pwned'))).toHaveLength(1)
  })

  it('rejects an empty or flag-like pod', () => {
    expect(() => new KubectlExecutor({ pod: '' })).toThrow(RemoteExecutorError)
    expect(() => new KubectlExecutor({ pod: '-oProxyCommand=evil' })).toThrow(
      /must not start with "-"/,
    )
  })
})

describe('KubectlExecutor behaviour', () => {
  it('refuses RunOptions.env instead of silently dropping it', async () => {
    const { executor, recorder } = makeExecutor()
    const rejection = executor.run(['true'], { env: { PGPASSWORD: 'secret' } })
    await expect(rejection).rejects.toBeInstanceOf(RemoteExecutorError)
    await expect(rejection).rejects.toMatchObject({ code: 'ENV_NOT_SUPPORTED' })
    expect(recorder.calls).toHaveLength(0)
  })

  it('spawns kubectl with the full argv', async () => {
    const { executor, recorder } = makeExecutor(undefined, { namespace: 'pg' })
    const pending = executor.run(['pgbackrest', 'info'])
    const call = recorder.calls[0]
    expect(call?.command).toBe('kubectl')
    expect(call?.args?.at(-1)).toBe('info')
    expect(call?.options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    recorder.child().close(0, null)
    const result = await pending
    expect(result.executionSite).toBe('kubectl:pg/db-0')
    expect(result.argv).toEqual(['pgbackrest', 'info'])
  })

  it('reports a timeout and kills the transport', async () => {
    const { executor, recorder } = makeExecutor()
    const result = await executor.run(['sleep', '60'], { timeoutMs: 20 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(-1)
    expect(recorder.child().killed).toContain('SIGTERM')
  })

  it('kills the transport when the signal aborts', async () => {
    const { executor, recorder } = makeExecutor()
    const controller = new AbortController()
    const pending = executor.run(['sleep', '60'], { signal: controller.signal })
    controller.abort()
    const result = await pending
    expect(result.timedOut).toBe(false)
    expect(result.signal).not.toBeNull()
    expect(recorder.child().killed).toContain('SIGTERM')
  })

  it('truncates output and flags it', async () => {
    const { executor, recorder } = makeExecutor(undefined, { maxOutputBytes: 3 })
    const pending = executor.run(['printf', 'abcdef'])
    recorder.child().write('stdout', 'abcdef')
    recorder.child().close(0, null)
    const result = await pending
    expect(result.stdout).toBe('abc')
    expect(result.truncated).toBe(true)
  })

  it('streams stdout chunks', async () => {
    const { executor, recorder } = makeExecutor()
    const chunks: string[] = []
    const collecting = (async () => {
      for await (const chunk of executor.stream(['printf', 'hi'])) chunks.push(chunk.text)
    })()
    const child = recorder.child()
    child.write('stdout', 'a')
    child.write('stdout', 'b')
    child.close(0, null)
    await collecting
    expect(chunks.join('')).toBe('ab')
  })
})
