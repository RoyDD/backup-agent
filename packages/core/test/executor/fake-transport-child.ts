import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { ChildProcessLike, SpawnImpl } from '../../src/executor/spawned-process'

/**
 * Test double for the local transport binary (`ssh` / `kubectl`). No real
 * process is started, so tests can assert the exact argv the control plane
 * would execute and drive output, exit and kill behaviour deterministically.
 */

export interface SpawnedCall {
  command: string
  args: readonly string[]
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] }
}

export class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = null
  readonly killed: NodeJS.Signals[] = []

  private readonly exitOnSigterm: boolean
  private closed = false

  constructor(exitOnSigterm = true) {
    super()
    this.exitOnSigterm = exitOnSigterm
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    if (signal === 'SIGKILL' || this.exitOnSigterm) this.close(null, signal)
    return true
  }

  /** Ends both streams and emits `close` on a later tick, like a real child. */
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', code, signal))
  }

  write(stream: 'stdout' | 'stderr', text: string): void {
    const target = stream === 'stdout' ? this.stdout : this.stderr
    target.write(text)
  }
}

export interface TransportRecorder {
  readonly spawnImpl: SpawnImpl
  readonly calls: SpawnedCall[]
  child(): FakeChild
}

export function createRecorder(options: { exitOnSigterm?: boolean } = {}): TransportRecorder {
  const calls: SpawnedCall[] = []
  const children: FakeChild[] = []

  const spawnImpl: SpawnImpl = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], options: spawnOptions })
    const child = new FakeChild(options.exitOnSigterm ?? true)
    children.push(child)
    return child
  }

  return {
    spawnImpl,
    calls,
    child: () => {
      const last = children.at(-1)
      if (!last) throw new Error('no child was spawned')
      return last
    },
  }
}
