/** Thrown when an outbound call did not finish within its time limit on every attempt. */
export class OutboundTimeout extends Error {
  constructor() {
    super('outbound_timeout')
  }
}

/** How an outbound call is bounded and retried. */
export interface OutboundPolicy {
  /** Each attempt is abandoned (and its signal aborted) after this many milliseconds. */
  timeoutMs: number
  /** Extra attempts after the first failure. */
  retries: number
  /** Base of the exponential backoff, in milliseconds. */
  backoffMs: number
  /** Uniform random in [0, 1): the jitter source. */
  random: () => number
  /** Waits `ms` milliseconds. */
  sleep: (ms: number) => Promise<void>
}

/** The wait before retry number `attempt` (0-based): exponential, scaled by jitter into [0.5, 1.5). */
export function backoffDelay(policy: OutboundPolicy, attempt: number): number {
  return Math.round(policy.backoffMs * 2 ** attempt * (0.5 + policy.random()))
}

/**
 * Runs an outbound call with a timeout per attempt and jittered exponential retries. `call`
 * receives an AbortSignal that fires at the timeout. Throws {@link OutboundTimeout} when the last
 * attempt timed out, else the last attempt's error.
 */
export async function withOutbound<T>(
  policy: OutboundPolicy,
  call: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  let last: unknown
  for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
    if (attempt > 0) {
      await policy.sleep(backoffDelay(policy, attempt - 1))
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new OutboundTimeout())
      }, policy.timeoutMs)
    })
    try {
      return await Promise.race([call(controller.signal), timeout])
    } catch (error) {
      last = error
    } finally {
      clearTimeout(timer)
    }
  }
  throw last
}
