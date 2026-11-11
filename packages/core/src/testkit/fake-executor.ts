import type { Argv, Executor, OutputChunk, RunOptions, RunResult } from '../ports/executor'

export interface ScriptedResponse {
  exitCode?: number
  stdout?: string
  stderr?: string
  delayMs?: number
  timedOut?: boolean
  signal?: string | null
  chunks?: readonly OutputChunk[]
  /** When set, run()/stream() reject with this message. */
  throws?: string
}

export interface ExecutorCall {
  argv: readonly string[]
  opts?: RunOptions
}

export interface FakeRule {
  match: readonly string[] | ((cmd: readonly string[]) => boolean)
  response: ScriptedResponse
}

export interface FakeExecutorOptions {
  site?: string
  defaultHandler?: (cmd: readonly string[]) => ScriptedResponse | undefined
}

function matches(cmd: readonly string[], match: FakeRule['match']): boolean {
  if (typeof match === 'function') return match(cmd)
  if (match.length !== cmd.length) return false
  return match.every((value, index) => value === cmd[index])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Deterministic Executor double. Rules are consumed FIFO; an unmatched call
 * without a default handler fails loudly instead of silently succeeding.
 */
export class FakeExecutor implements Executor {
  readonly site: string
  readonly calls: ExecutorCall[] = []
  private readonly rules: FakeRule[] = []
  private readonly defaultHandler?: (cmd: readonly string[]) => ScriptedResponse | undefined

  constructor(options: FakeExecutorOptions = {}) {
    this.site = options.site ?? 'fake'
    this.defaultHandler = options.defaultHandler
  }

  enqueue(rule: FakeRule): void {
    this.rules.push(rule)
  }

  private resolve(cmd: readonly string[]): ScriptedResponse {
    const index = this.rules.findIndex((rule) => matches(cmd, rule.match))
    if (index >= 0) {
      const [rule] = this.rules.splice(index, 1)
      if (rule) return rule.response
    }
    const fallback = this.defaultHandler?.(cmd)
    if (fallback !== undefined) return fallback
    throw new Error(`FakeExecutor: no scripted response for argv: ${cmd.join(' ')}`)
  }

  async run(cmd: Argv, opts: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ argv: [...cmd], opts })
    const response = this.resolve(cmd)
    if (response.delayMs !== undefined && response.delayMs > 0) await sleep(response.delayMs)
    if (response.throws !== undefined) throw new Error(response.throws)

    const timedOut = response.timedOut ?? false
    return {
      argv: [...cmd],
      exitCode: response.exitCode ?? 0,
      signal: response.signal ?? (timedOut ? 'SIGKILL' : null),
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
      durationMs: response.delayMs ?? 0,
      timedOut,
      truncated: false,
      executionSite: this.site,
    }
  }

  async *stream(cmd: Argv, opts: RunOptions = {}): AsyncIterable<OutputChunk> {
    this.calls.push({ argv: [...cmd], opts })
    const response = this.resolve(cmd)
    if (response.delayMs !== undefined && response.delayMs > 0) await sleep(response.delayMs)
    if (response.throws !== undefined) throw new Error(response.throws)

    if (response.chunks) {
      for (const chunk of response.chunks) yield chunk
      return
    }
    if (response.stdout !== undefined && response.stdout !== '') {
      yield { stream: 'stdout', text: response.stdout }
    }
    if (response.stderr !== undefined && response.stderr !== '') {
      yield { stream: 'stderr', text: response.stderr }
    }
  }
}
