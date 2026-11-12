import type { Argv, Executor, OutputChunk, RunOptions, RunResult } from '../ports/executor'
import { assertNoNulArguments, posixCommand, RemoteExecutorError } from './posix-quote'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  defaultSpawnImpl,
  localEnv,
  runSpawnedProcess,
  streamSpawnedProcess,
} from './spawned-process'
import type { SpawnImpl, SpawnRequest } from './spawned-process'

export type { ChildProcessLike, SpawnImpl } from './spawned-process'

/**
 * SSH transport.
 *
 * Host-key pinning is not optional: `knownHostsFile` is required and the client
 * always runs `StrictHostKeyChecking=yes` with `BatchMode=yes`, so an unknown or
 * changed host key aborts instead of prompting or trusting on first use.
 *
 * The remote command is the last argv element and is produced by
 * `posixCommand()`: that string is parsed by the login shell on the far side,
 * which is exactly why every element is quoted. The control plane never builds
 * a local shell string and never spawns a local shell.
 *
 * `RunOptions.env` is rejected. ssh has no way to forward the remote child's
 * environment (`SendEnv` must be allowed by the server's `AcceptEnv`, and
 * `BatchMode=yes` rules out prompting), so accepting an env map would silently
 * drop credentials. That is why provider credential delivery over SSH is still
 * an open item; until then credentials reach a remote target through the
 * remote's own configuration, not through this transport.
 */
export interface SshExecutorOptions {
  /** `user@host` or `host`. Host-key verification applies either way. */
  host: string
  /** REQUIRED: host-key pinning is not optional. */
  knownHostsFile: string
  port?: number
  identityFile?: string
  /** Defaults to 10s so a black-holed host cannot stall a plan step forever. */
  connectTimeoutSeconds?: number
  /** Test seam; defaults to `node:child_process` spawn. */
  spawnImpl?: SpawnImpl
  /** Default 1 MiB per stream. */
  maxOutputBytes?: number
}

const HOST_PATTERN = /^[A-Za-z0-9_.@:-]+$/
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10

function requireNonEmpty(value: string, field: string): string {
  if (value.trim() === '') {
    throw new RemoteExecutorError('INVALID_ARGV', `${field} must not be empty`)
  }
  if (value.includes('\0')) {
    throw new RemoteExecutorError('INVALID_ARGV', `${field} must not contain a NUL byte`)
  }
  return value
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RemoteExecutorError('INVALID_ARGV', `${field} must be a positive integer`)
  }
  return value
}

export class SshExecutor implements Executor {
  readonly site: string

  private readonly host: string
  private readonly knownHostsFile: string
  private readonly port: number | undefined
  private readonly identityFile: string | undefined
  private readonly connectTimeoutSeconds: number
  private readonly spawnImpl: SpawnImpl
  private readonly maxOutputBytes: number

  constructor(options: SshExecutorOptions) {
    if (!HOST_PATTERN.test(options.host) || options.host.startsWith('-')) {
      throw new RemoteExecutorError(
        'INVALID_HOST',
        `invalid ssh host ${JSON.stringify(options.host)}: expected [A-Za-z0-9_.@:-]+ and no leading "-"`,
      )
    }
    this.host = options.host
    // Without a pinned known-hosts file, `StrictHostKeyChecking=yes` would fall
    // back to the operator's default file, i.e. implicit trust. Refuse instead.
    // The value is passed to ssh verbatim (`~` expansion is ssh's job), so it is
    // only checked for emptiness and NUL.
    this.knownHostsFile = requireNonEmpty(options.knownHostsFile, 'knownHostsFile')
    this.port =
      options.port === undefined
        ? undefined
        : requirePositiveInteger(options.port, 'port')
    if (this.port !== undefined && this.port > 65535) {
      throw new RemoteExecutorError('INVALID_ARGV', 'port must be <= 65535')
    }
    this.identityFile =
      options.identityFile === undefined
        ? undefined
        : requireNonEmpty(options.identityFile, 'identityFile')
    this.connectTimeoutSeconds =
      options.connectTimeoutSeconds === undefined
        ? DEFAULT_CONNECT_TIMEOUT_SECONDS
        : requirePositiveInteger(options.connectTimeoutSeconds, 'connectTimeoutSeconds')
    this.spawnImpl = options.spawnImpl ?? defaultSpawnImpl
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    this.site = `ssh:${this.host}`
  }

  /** Transport argv for one invocation; also the unit the tests assert on. */
  buildArgv(cmd: Argv): readonly string[] {
    const args: string[] = [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${this.knownHostsFile}`,
      '-o',
      `ConnectTimeout=${this.connectTimeoutSeconds}`,
    ]
    if (this.port !== undefined) args.push('-p', String(this.port))
    if (this.identityFile !== undefined) args.push('-i', this.identityFile)
    args.push(this.host, posixCommand(cmd))
    return args
  }

  async run(cmd: Argv, opts: RunOptions = {}): Promise<RunResult> {
    return await runSpawnedProcess(this.buildRequest(cmd, opts))
  }

  async *stream(cmd: Argv, opts: RunOptions = {}): AsyncIterable<OutputChunk> {
    yield* streamSpawnedProcess(this.buildRequest(cmd, opts))
  }

  private buildRequest(cmd: Argv, opts: RunOptions): SpawnRequest {
    if (cmd.length === 0) {
      throw new RemoteExecutorError('INVALID_ARGV', 'argv must not be empty')
    }
    assertNoNulArguments(cmd)
    const envKeys = Object.keys(opts.env ?? {})
    if (envKeys.length > 0) {
      throw new RemoteExecutorError(
        'ENV_NOT_SUPPORTED',
        `ssh cannot forward the remote child environment; refusing to drop ${envKeys.length} variable(s): ${envKeys.join(',')}`,
      )
    }
    // `opts.cwd` is not forwarded either: the working directory is whatever the
    // remote login shell provides, so relative remote paths stay unsupported.
    return {
      argv: cmd,
      command: 'ssh',
      args: this.buildArgv(cmd),
      env: localEnv(),
      executionSite: this.site,
      spawnImpl: this.spawnImpl,
      maxOutputBytes: opts.maxOutputBytes ?? this.maxOutputBytes,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    }
  }
}
