/**
 * Serializes access to a single SQLite connection. `node:sqlite` is
 * synchronous, but the Repository port is async, so every entry point is
 * queued to keep transactions from interleaving across awaits.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
