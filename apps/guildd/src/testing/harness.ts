import { MemoryClock } from '../adapters/memory-clock'
import { compose } from '../composition'

/** Options for {@link createHarness}. */
export interface HarnessOptions {
  /** Instant the memory clock starts at. */
  now?: Date
}

/**
 * In-process contract harness: builds guildd from the composition root with memory
 * adapters and drives its public routes through `app.request`.
 */
export function createHarness(options: HarnessOptions = {}) {
  const clock = new MemoryClock(options.now ?? new Date('2026-01-01T00:00:00.000Z'))
  const { app } = compose({ clock })
  return {
    adapters: { clock },
    /** Sends a request to guildd without opening a socket. */
    request: (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init)),
  }
}
