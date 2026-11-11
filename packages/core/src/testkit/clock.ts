import type { Clock } from '../ports/clock'

/** Deterministic clock for tests and replay. */
export class FixedClock implements Clock {
  private current: Date

  constructor(start: string | Date) {
    this.current = typeof start === 'string' ? new Date(start) : new Date(start.getTime())
  }

  now(): Date {
    return new Date(this.current.getTime())
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }

  set(value: string | Date): void {
    this.current = typeof value === 'string' ? new Date(value) : new Date(value.getTime())
  }
}
