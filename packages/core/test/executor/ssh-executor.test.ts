import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { RemoteExecutorError } from '../../src/executor/posix-quote'
import { SshExecutor } from '../../src/executor/ssh-executor'
import { runSpawnedProcess } from '../../src/executor/spawned-process'
import { createRecorder } from './fake-transport-child'

const KNOWN_HOSTS = '/etc/backup-agent/known_hosts'
const HOST = 'dba@db1.internal'

function makeExecutor(
  recorder = createRecorder(),
  overrides: Partial<ConstructorParameters<typeof SshExecutor>[0]> = {},
): { executor: SshExecutor; recorder: ReturnType<typeof createRecorder> } {
  const executor = new SshExecutor({
    host: HOST,
    knownHostsFile: KNOWN_HOSTS,
    spawnImpl: recorder.spawnImpl,
    ...overrides,
  })
  return { executor, recorder }
}

describe('SshExecutor argv', () => {
  it('pins the host key and sends exactly one command string last', () => {
    const { executor, recorder } = makeExecutor()
    const pending = executor.run(['pgbackrest', '--stanza=main', 'backup'])

    const call = recorder.calls[0]
    expect(call?.command).toBe('ssh')
    const args = call?.args ?? []
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('StrictHostKeyChecking=yes')
    expect(args).toContain(`UserKnownHostsFile=${KNOWN_HOSTS}`)
    expect(args).toContain('ConnectTimeout=10')
    // Host is last-but-one and the encoded command is the final element.
    expect(args.at(-2)).toBe(HOST)
    expect(args.at(-1)).toBe('pgbackrest --stanza=main backup')
    // No transport flag may sit between the host and the command.
    expect(args.filter((arg) => arg.includes('pgbackrest'))).toHaveLength(1)
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-i')

    recorder.child().close(0, null)
    return pending
  })

  it('adds -p and -i only when configured', () => {
    const { executor } = makeExecutor(createRecorder(), {
      port: 2222,
      identityFile: '/keys/id_ed25519',
    })
    const argv = executor.buildArgv(['true'])
    const portIndex = argv.indexOf('-p')
    expect(portIndex).toBeGreaterThan(-1)
    expect(argv[portIndex + 1]).toBe('2222')
    expect(argv[argv.indexOf('-i') + 1]).toBe('/keys/id_ed25519')
    expect(argv.at(-2)).toBe(HOST)
    expect(argv.at(-1)).toBe('true')
  })

  it('keeps the command as one element even for shell metacharacters', () => {
    const { executor } = makeExecutor()
    const argv = executor.buildArgv(['printf', '%s', 'a; echo pwned'])
    expect(argv.at(-1)).toBe("printf %s 'a; echo pwned'")
    expect(argv.filter((arg) => arg.includes('echo pwned'))).toHaveLength(1)
  })

  it('rejects an unsafe or option-like host', () => {
    expect(
      () => new SshExecutor({ host: '-oProxyCommand=evil', knownHostsFile: KNOWN_HOSTS }),
    ).toThrow(RemoteExecutorError)
    expect(
      () => new SshExecutor({ host: 'db1; rm -rf /', knownHostsFile: KNOWN_HOSTS }),
    ).toThrow(RemoteExecutorError)
    expect(() => new SshExecutor({ host: 'db1', knownHostsFile: '' })).toThrow(/knownHostsFile/)
  })
})

describe('SshExecutor behaviour', () => {
  it('refuses RunOptions.env instead of silently dropping it', async () => {
    const { executor, recorder } = makeExecutor()
    const rejection = executor.run(['true'], { env: { PGPASSWORD: 'secret' } })
    await expect(rejection).rejects.toBeInstanceOf(RemoteExecutorError)
    await expect(rejection).rejects.toMatchObject({ code: 'ENV_NOT_SUPPORTED' })
    expect(recorder.calls).toHaveLength(0)
  })

  it('accepts an explicitly empty env map', async () => {
    const { executor, recorder } = makeExecutor()
    const pending = executor.run(['true'], { env: {} })
    recorder.child().close(0, null)
    await expect(pending).resolves.toMatchObject({ exitCode: 0 })
  })

  it('reports a timeout and kills the transport', async () => {
    const { executor, recorder } = makeExecutor()
    const result = await executor.run(['sleep', '60'], { timeoutMs: 20 })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(-1)
    expect(result.signal).toBe('SIGTERM')
    expect(result.executionSite).toBe(`ssh:${HOST}`)
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

  it('truncates both streams to maxOutputBytes and flags it', async () => {
    const { executor, recorder } = makeExecutor(createRecorder(), { maxOutputBytes: 4 })
    const pending = executor.run(['printf', '%s', 'abcdefgh'])
    recorder.child().write('stdout', 'abcdefgh')
    recorder.child().write('stderr', '12345678')
    recorder.child().close(0, null)
    const result = await pending
    expect(result.stdout).toBe('abcd')
    expect(result.stderr).toBe('1234')
    expect(result.truncated).toBe(true)
  })

  it('reports argv, exit code and duration of the remote command', async () => {
    const { executor, recorder } = makeExecutor()
    const argv = ['pgbackrest', 'info']
    const pending = executor.run(argv)
    recorder.child().write('stdout', 'stanza: main\n')
    recorder.child().close(1, null)
    const result = await pending
    expect(result.argv).toEqual(argv)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('stanza: main\n')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
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

  it('escalates to SIGKILL when the transport ignores SIGTERM', async () => {
    const recorder = createRecorder({ exitOnSigterm: false })
    const result = await runSpawnedProcess({
      argv: ['true'],
      command: 'ssh',
      args: ['ssh', HOST, 'true'],
      env: {},
      executionSite: `ssh:${HOST}`,
      spawnImpl: recorder.spawnImpl,
      maxOutputBytes: 1024,
      timeoutMs: 5,
      killEscalationMs: 10,
    })
    expect(result.timedOut).toBe(true)
    expect(recorder.child().killed).toEqual(['SIGTERM', 'SIGKILL'])
  })
})

describe('SshExecutor end to end (no fake spawn for the payload)', () => {
  it('delivers an injection attempt as a single literal argument', async () => {
    const { executor, recorder } = makeExecutor()
    const payload = 'a; echo pwned'
    const pending = executor.run(['printf', '%s', payload])

    const remoteCommand = recorder.calls[0]?.args.at(-1) ?? ''
    // Run the encoded command through a real POSIX shell: the payload must arrive
    // verbatim, i.e. no second command is executed.
    const output = execFileSync('sh', ['-c', remoteCommand], { encoding: 'utf8' })
    expect(output).toBe(payload)
    expect(remoteCommand).not.toBe(`printf %s ${payload}`)
    expect(output).not.toContain('pwned\npwned')

    recorder.child().write('stdout', output)
    recorder.child().close(0, null)
    const result = await pending
    expect(result.stdout).toBe(payload)
  })
})
