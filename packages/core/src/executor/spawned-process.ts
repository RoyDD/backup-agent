import { spawn } from 'node:child_process'

import type { OutputChunk, RunResult } from '../ports/executor'
import { RemoteExecutorError } from './posix-quote'

/**
 * Child-process plumbing shared by the remote transports (`ssh`, `kubectl`).
 *
 * The remote transports differ only in how they build the local argv; timeout,
 * abort, kill escalation, output retention and truncation must behave
 * identically, so they live here. `local-executor.ts` deliberately keeps its own
 * copy: it is the reference transport for the `Executor` contract and is not
 * being rewritten.
 */

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** Kill escalates `SIGTERM` then `SIGKILL` after this delay. */
export const DEFAULT_KILL_ESCALATION_MS = 2000

/** The subset of `ChildProcess` the transports rely on; a test seam. */
export interface ChildProcessLike {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  readonly stdin: NodeJS.WritableStream | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

/**
 * Spawns the local transport binary. `stdio` is fixed to
 * `['ignore','pipe','pipe']`: remote commands do not receive stdin, and the
 * transports always capture both output streams.
 */
export interface SpawnImpl {
  (command: string, args: readonly string[], options: {
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
  }): ChildProcessLike
}

export const defaultSpawnImpl: SpawnImpl = (command, args, options) =>
  spawn(command, [...args], { env: options.env, stdio: options.stdio, shell: false })

/** Environment inherited by the *local* transport binary (PATH, HOME, agent socket). */
export function localEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Everything needed to run one remote command. */
export interface SpawnRequest {
  /** The argv the remote program must receive; reported back as `RunResult.argv`. */
  readonly argv: readonly string[]
  /** Local binary: `ssh` or `kubectl`. */
  readonly command: string
  /** Local argv for `command`, transport flags included. */
  readonly args: readonly string[]
  /** Environment for the local transport binary, never the remote child. */
  readonly env: NodeJS.ProcessEnv
  readonly executionSite: string
  readonly spawnImpl: SpawnImpl
  readonly maxOutputBytes: number
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /** Test seam; production always uses `DEFAULT_KILL_ESCALATION_MS`. */
  readonly killEscalationMs?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface AppendResult {
  text: string
  bytes: number
  truncated: boolean
}

function appendChunk(current: string, chunk: Buffer, used: number, max: number): AppendResult {
  if (used >= max) return { text: current, bytes: used, truncated: chunk.length > 0 }
  const remaining = max - used
  const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
  return {
    text: current + slice.toString('utf8'),
    bytes: used + slice.length,
    truncated: chunk.length > slice.length,
  }
}

interface Termination {
  /** Sets the timed-out flag, then asks the child to stop. */
  request(): void
  /** Clears the timeout and escalation timers. */
  clear(): void
}

function makeTermination(child: ChildProcessLike, request: SpawnRequest): Termination {
  let escalation: NodeJS.Timeout | undefined

  const killSoftly = (): void => {
    try {
      child.kill('SIGTERM')
    } catch {
      // The child may already be gone; the close handler still settles.
    }
    if (escalation) return
    escalation = setTimeout(() => {
      escalation = undefined
      try {
        child.kill('SIGKILL')
      } catch {
        // Same as above: a dead child is not an error here.
      }
    }, request.killEscalationMs ?? DEFAULT_KILL_ESCALATION_MS)
  }

  return {
    request: killSoftly,
    clear: () => {
      if (escalation) {
        clearTimeout(escalation)
        escalation = undefined
      }
    },
  }
}

/**
 * Runs one remote command to completion. Timeouts and aborts terminate the
 * child (SIGTERM, then SIGKILL) and are reported as results, never thrown.
 */
export function runSpawnedProcess(request: SpawnRequest): Promise<RunResult> {
  const started = performance.now()
  let child: ChildProcessLike
  try {
    child = request.spawnImpl(request.command, request.args, {
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return Promise.reject(
      new RemoteExecutorError(
        'SPAWN_FAILED',
        `failed to spawn ${request.command}: ${errorMessage(error)}`,
      ),
    )
  }

  return new Promise<RunResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const termination = makeTermination(child, request)

    const onAbort = (): void => termination.request()

    const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      termination.clear()
      request.signal?.removeEventListener('abort', onAbort)
      resolve({
        argv: request.argv,
        exitCode,
        signal: signal ?? null,
        stdout,
        stderr,
        durationMs: performance.now() - started,
        timedOut,
        truncated,
        executionSite: request.executionSite,
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = appendChunk(stdout, chunk, stdoutBytes, request.maxOutputBytes)
      stdout = next.text
      stdoutBytes = next.bytes
      truncated = truncated || next.truncated
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = appendChunk(stderr, chunk, stderrBytes, request.maxOutputBytes)
      stderr = next.text
      stderrBytes = next.bytes
      truncated = truncated || next.truncated
    })

    child.on('error', (error) => {
      stderr = stderr === '' ? error.message : `${stderr}\n${error.message}`
      finish(127, null)
    })
    child.on('close', (code, signal) => finish(code ?? -1, signal))

    if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        termination.request()
      }, request.timeoutMs)
    }

    if (request.signal) {
      if (request.signal.aborted) termination.request()
      else request.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * Streams one remote command. `maxOutputBytes` caps the bytes forwarded per
 * stream; anything beyond the cap is dropped (the streaming interface has no
 * truncation flag).
 */
export async function* streamSpawnedProcess(
  request: SpawnRequest,
): AsyncIterable<OutputChunk> {
  let child: ChildProcessLike
  try {
    child = request.spawnImpl(request.command, request.args, {
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new RemoteExecutorError(
      'SPAWN_FAILED',
      `failed to spawn ${request.command}: ${errorMessage(error)}`,
    )
  }

  const queue: OutputChunk[] = []
  let done = false
  let failure: Error | undefined
  let notify: (() => void) | null = null
  let timer: NodeJS.Timeout | undefined
  let stdoutBytes = 0
  let stderrBytes = 0

  const wake = (): void => {
    if (notify) {
      const resolve = notify
      notify = null
      resolve()
    }
  }
  const push = (chunk: OutputChunk): void => {
    queue.push(chunk)
    wake()
  }
  const forward = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const used = stream === 'stdout' ? stdoutBytes : stderrBytes
    if (used >= request.maxOutputBytes) return
    const remaining = request.maxOutputBytes - used
    const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining)
    if (stream === 'stdout') stdoutBytes += slice.length
    else stderrBytes += slice.length
    push({ stream, text: slice.toString('utf8') })
  }

  const termination = makeTermination(child, request)
  const onAbort = (): void => termination.request()

  child.stdout?.on('data', (chunk: Buffer) => forward('stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => forward('stderr', chunk))
  child.on('error', (error) => {
    failure = error
  })
  child.on('close', () => {
    done = true
    wake()
  })

  if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
    timer = setTimeout(() => termination.request(), request.timeoutMs)
  }
  if (request.signal) {
    if (request.signal.aborted) termination.request()
    else request.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    while (true) {
      const pending = queue.shift()
      if (pending !== undefined) {
        yield pending
        continue
      }
      if (done) break
      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }
    if (failure) throw failure
  } finally {
    if (timer) clearTimeout(timer)
    termination.clear()
    request.signal?.removeEventListener('abort', onAbort)
    if (!done) {
      try {
        child.kill('SIGKILL')
      } catch {
        // The child is already gone.
      }
    }
  }
}
