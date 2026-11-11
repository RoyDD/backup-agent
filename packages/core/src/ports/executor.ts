import type { ErrorClass } from '../domain/errors'

/** An argument vector. Shell strings are never accepted. */
export type Argv = readonly string[]

export interface RunOptions {
  cwd?: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  signal?: AbortSignal
  stdin?: string
  /** Maximum bytes retained per stream; excess is truncated and flagged. */
  maxOutputBytes?: number
}

export interface RunResult {
  readonly argv: Argv
  readonly exitCode: number
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
  readonly truncated: boolean
  /** Where the command actually ran: `local`, `ssh:<host>`, `kubectl:<context>`. */
  readonly executionSite: string
  /** Populated by `classifyRunResult`; adapters may leave it undefined. */
  readonly errorClass?: ErrorClass
}

export interface OutputChunk {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

/**
 * Transport seam between the control plane and external programs.
 * Implementations must not interpret `argv` as a shell command line.
 */
export interface Executor {
  readonly site: string
  run(cmd: Argv, opts?: RunOptions): Promise<RunResult>
  stream(cmd: Argv, opts?: RunOptions): AsyncIterable<OutputChunk>
}
