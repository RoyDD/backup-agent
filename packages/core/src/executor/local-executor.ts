import { spawn } from 'node:child_process'
import type { Argv, Executor, OutputChunk, RunOptions, RunResult } from '../ports/executor'

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

function buildEnv(extra: RunOptions['env']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  if (extra) {
    for (const [key, value] of Object.entries(extra)) env[key] = value
  }
  return env
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

/**
 * Runs programs on the local host. Commands are always argv arrays; no shell
 * is involved, so metacharacters are data rather than syntax.
 */
export class LocalExecutor implements Executor {
  readonly site = 'local'

  async run(cmd: Argv, opts: RunOptions = {}): Promise<RunResult> {
    if (cmd.length === 0) throw new Error('argv must not be empty')

    const started = performance.now()
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    return await new Promise<RunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let timedOut = false
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const child = spawn(cmd[0] as string, cmd.slice(1), {
        cwd: opts.cwd,
        env: buildEnv(opts.env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const onAbort = (): void => {
        child.kill('SIGKILL')
      }

      const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({
          argv: cmd,
          exitCode,
          signal: signal ?? null,
          stdout,
          stderr,
          durationMs: performance.now() - started,
          timedOut,
          truncated,
          executionSite: this.site,
        })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const next = appendChunk(stdout, chunk, stdoutBytes, maxBytes)
        stdout = next.text
        stdoutBytes = next.bytes
        truncated = truncated || next.truncated
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const next = appendChunk(stderr, chunk, stderrBytes, maxBytes)
        stderr = next.text
        stderrBytes = next.bytes
        truncated = truncated || next.truncated
      })

      child.on('error', (error) => {
        stderr = stderr === '' ? error.message : `${stderr}\n${error.message}`
        finish(127, null)
      })
      child.on('close', (code, signal) => finish(code ?? -1, signal))

      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      }

      if (opts.signal) {
        if (opts.signal.aborted) child.kill('SIGKILL')
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
      else child.stdin?.end()
    })
  }

  async *stream(cmd: Argv, opts: RunOptions = {}): AsyncIterable<OutputChunk> {
    if (cmd.length === 0) throw new Error('argv must not be empty')

    const child = spawn(cmd[0] as string, cmd.slice(1), {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const queue: OutputChunk[] = []
    let done = false
    let failure: Error | undefined
    let notify: (() => void) | null = null
    let timer: NodeJS.Timeout | undefined

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

    child.stdout?.on('data', (chunk: Buffer) => push({ stream: 'stdout', text: chunk.toString('utf8') }))
    child.stderr?.on('data', (chunk: Buffer) => push({ stream: 'stderr', text: chunk.toString('utf8') }))
    child.on('error', (error) => {
      failure = error
    })
    child.on('close', () => {
      done = true
      wake()
    })

    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
    }
    if (opts.signal) {
      if (opts.signal.aborted) child.kill('SIGKILL')
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
    else child.stdin?.end()

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
      opts.signal?.removeEventListener('abort', onAbort)
      if (!done) child.kill('SIGKILL')
    }
  }
}
