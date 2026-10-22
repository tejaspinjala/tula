/** A caller waiting on a save's outcome. */
interface Waiter<R> {
  resolve: (result: R) => void
  reject: (error: unknown) => void
}

/**
 * Sends saves one at a time and keeps only the newest one waiting: while a save is in flight, a
 * newer `enqueue` replaces any queued input, and every caller whose input was superseded resolves
 * (or rejects) with the result of the save that replaced it. One queue serves one Rite.
 */
export class SaveQueue<I, R> {
  private running = false
  private queued: { input: I; waiters: Waiter<R>[] } | null = null

  constructor(private readonly send: (input: I) => Promise<R>) {}

  /** Saves `input` now, or after the save in flight; resolves with the result that covers it. */
  enqueue(input: I): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const waiter = { resolve, reject }
      if (this.queued) {
        this.queued.input = input
        this.queued.waiters.push(waiter)
      } else if (this.running) {
        this.queued = { input, waiters: [waiter] }
      } else {
        void this.run(input, [waiter])
      }
    })
  }

  private async run(input: I, waiters: Waiter<R>[]): Promise<void> {
    this.running = true
    try {
      const result = await this.send(input)
      for (const w of waiters) {
        w.resolve(result)
      }
    } catch (error) {
      for (const w of waiters) {
        w.reject(error)
      }
    }
    this.running = false
    const next = this.queued
    this.queued = null
    if (next) {
      await this.run(next.input, next.waiters)
    }
  }
}
