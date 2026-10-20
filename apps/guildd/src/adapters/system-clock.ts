import type { Clock } from '../ports/clock'

/** Real adapter for {@link Clock}: reads the wall clock. */
export class SystemClock implements Clock {
  /** Returns the current wall-clock instant. */
  now(): Date {
    return new Date()
  }
}
