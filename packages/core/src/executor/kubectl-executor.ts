import type { Argv, Executor, OutputChunk, RunOptions, RunResult } from '../ports/executor'
import { assertNoNulArguments, RemoteExecutorError } from './posix-quote'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  defaultSpawnImpl,
  localEnv,
  runSpawnedProcess,
  streamSpawnedProcess,
} from './spawned-process'
import type { SpawnImpl, SpawnRequest } from './spawned-process'

/**
 * `kubectl exec` transport.
 *
 * Everything after `--` is a real argv: kubectl builds the remote exec request
 * from it, so the far side never sees a shell command string and nothing needs
 * quoting. Metacharacters in an argument are data end to end.
 *
 * `RunOptions.env` is rejected for the same reason as ssh: `kubectl exec` cannot
 * inject environment variables into the container process without wrapping it
 * in a shell (which is precisely the property this transport exists to keep),
 * so accepting the map would silently drop credentials.
 */
export interface KubectlExecutorOptions {
  pod: string
  namespace?: string
  container?: string
  context?: string
  kubeconfig?: string
  /** Test seam; defaults to `node:child_process` spawn. */
  spawnImpl?: SpawnImpl
  /** Default 1 MiB per stream. */
  maxOutputBytes?: number
}

function requireFlagValue(value: string, field: string): string {
  if (value.trim() === '') {
    throw new RemoteExecutorError('INVALID_ARGV', `${field} must not be empty`)
  }
  if (value.includes('\0')) {
    throw new RemoteExecutorError('INVALID_ARGV', `${field} must not contain a NUL byte`)
  }
  return value
}

export class KubectlExecutor implements Executor {
  readonly site: string

  private readonly pod: string
  private readonly namespace: string | undefined
  private readonly container: string | undefined
  private readonly context: string | undefined
  private readonly kubeconfig: string | undefined
  private readonly spawnImpl: SpawnImpl
  private readonly maxOutputBytes: number

  constructor(options: KubectlExecutorOptions) {
    // `pod` is the only bare positional in the argv, so a leading `-` would be
    // parsed by kubectl as a flag. The `--option=value` forms below cannot.
    if (options.pod.trim() === '' || options.pod.startsWith('-')) {
      throw new RemoteExecutorError(
        'INVALID_ARGV',
        `invalid pod ${JSON.stringify(options.pod)}: must be non-empty and must not start with "-"`,
      )
    }
    this.pod = requireFlagValue(options.pod, 'pod')
    this.namespace =
      options.namespace === undefined
        ? undefined
        : requireFlagValue(options.namespace, 'namespace')
    this.container =
      options.container === undefined
        ? undefined
        : requireFlagValue(options.container, 'container')
    this.context =
      options.context === undefined ? undefined : requireFlagValue(options.context, 'context')
    this.kubeconfig =
      options.kubeconfig === undefined
        ? undefined
        : requireFlagValue(options.kubeconfig, 'kubeconfig')
    this.spawnImpl = options.spawnImpl ?? defaultSpawnImpl
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    // kubectl defaults to the `default` namespace unless the context overrides it.
    this.site = `kubectl:${this.namespace ?? 'default'}/${this.pod}`
  }

  /** Transport argv for one invocation; also the unit the tests assert on. */
  buildArgv(cmd: Argv): readonly string[] {
    const args: string[] = ['kubectl', 'exec']
    if (this.namespace !== undefined) args.push(`--namespace=${this.namespace}`)
    if (this.context !== undefined) args.push(`--context=${this.context}`)
    if (this.kubeconfig !== undefined) args.push(`--kubeconfig=${this.kubeconfig}`)
    args.push(this.pod)
    if (this.container !== undefined) args.push(`--container=${this.container}`)
    args.push('--', ...cmd)
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
        `kubectl exec cannot inject the container environment; refusing to drop ${envKeys.length} variable(s): ${envKeys.join(',')}`,
      )
    }
    return {
      argv: cmd,
      command: 'kubectl',
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
