import type { Clock } from '../ports/clock'

/** Memory adapter for {@link Clock}: a controllable clock for tests. */
export class MemoryClock implements Clock {
  private current: Date

  /** Creates a clock frozen at `start`. */
  constructor(start: Date) {
    this.current = start
  }

  /** Returns the frozen instant. */
  now(): Date {
    return new Date(this.current)
  }

  /** Moves the clock forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms)
  }
}
