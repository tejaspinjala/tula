/** A held reconnect timer: the page asked to run `run` after `delay` ms. */
interface HeldTimer {
  run: () => void
  delay: number
}

/** Test control over reconnect timers; see {@link holdReconnectTimers}. */
export interface ReconnectTimers {
  /** Every held delay, in the order the page asked for it. */
  delays: number[]
  /** Runs the oldest held timer, if any. */
  fireNext: () => void
  /** Puts the real timers and `Math.random` back. */
  restore: () => void
}

/**
 * Holds every timer of a quarter second or more (the reconnect waits) so a test fires them by
 * hand, and pins jitter to 0 so the waits are the lowest the backoff allows.
 */
export function holdReconnectTimers(): ReconnectTimers {
  const realTimeout = globalThis.setTimeout
  const realRandom = Math.random
  const held: HeldTimer[] = []
  const delays: number[] = []
  Math.random = () => 0
  Reflect.set(globalThis, 'setTimeout', (handler: TimerHandler, delay?: number) => {
    if (typeof handler === 'function' && typeof delay === 'number' && delay >= 100) {
      held.push({ run: () => handler(), delay })
      delays.push(delay)
      return 0
    }
    return realTimeout(handler, delay)
  })
  return {
    delays,
    fireNext: () => held.shift()?.run(),
    restore: () => {
      Reflect.set(globalThis, 'setTimeout', realTimeout)
      Math.random = realRandom
    },
  }
}
