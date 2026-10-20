import { z } from 'zod'
import type { Db } from './db/client'
import { eventsAfter, type GuildEvent, headSeq } from './events'
import type { Clock } from './ports/clock'
import { type PushNotifier, PushRejectedError } from './ports/push-notifier'
import type { PushStore } from './ports/push-store'

/** Collaborators and tuning of {@link createSealPushRelay}. */
export interface SealPushDeps {
  db: Db
  store: PushStore
  notifier: PushNotifier
  clock: Clock
  /** How long a delivery claim may stay pending before a crashed sender's claim is retried; default 60 s. */
  leaseMs?: number | undefined
  /** How long a guild's dispatch lease lasts without renewal (it is renewed per event); default 60 s. */
  dispatchLeaseMs?: number | undefined
  /** Send attempts per (Seal, device) before that device is given up on; default 5. */
  maxAttempts?: number | undefined
  /** Delay before a live relay re-dispatches a guild whose delivery is still pending; default 30 s. */
  retryMs?: number | undefined
  /** Dispatches running at once in this process, well under the database pool; default 4. */
  concurrency?: number | undefined
}

const BATCH = 100
const requested = z.object({ sealId: z.uuid() })

/** Thrown by `dispatch` while a transient failure or a live claim holds a delivery back. */
export class DeliveryPendingError extends Error {
  constructor() {
    super('delivery_pending')
    this.name = 'DeliveryPendingError'
  }
}

type Status = 'done' | 'busy'

/**
 * Pushes the Guild Master's devices when a Seal is requested, driven by the `seal.requested`
 * events in the guild's log (the transactional outbox). A guild is dispatched by one holder of
 * its dispatch lease at a time (a short database lease, never a transaction held across I/O);
 * a caller that cannot take it returns at once and the holder picks the new events up. In one
 * process there is one in-flight dispatch per guild and at most `concurrency` overall. A
 * per-guild cursor records how far the log is dispatched; a leased claim per (Seal, device)
 * makes repeats and crashes safe. A device added after an event (its `sinceSeq`) never receives
 * it. A device that can never be reached (bad key, refused, dropped by the push service) is
 * removed and does not hold the event back; a transient failure holds the cursor until the
 * device is delivered or its attempts run out. The push carries ids only: the client fetches
 * the Seal after the tap. Deterministic code; no model is involved.
 */
export function createSealPushRelay(deps: SealPushDeps) {
  const { db, store, notifier, clock } = deps
  const lease = { leaseMs: deps.leaseMs ?? 60_000, maxAttempts: deps.maxAttempts ?? 5 }
  const dispatchLeaseMs = deps.dispatchLeaseMs ?? 60_000
  const cap = deps.concurrency ?? 4
  const holder = crypto.randomUUID()

  let active = 0
  const waiting: Array<() => void> = []
  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= cap) {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }

  /** Pushes one Seal request to every device; true when every device is settled. */
  async function notify(guildId: string, event: GuildEvent, sealId: string): Promise<boolean> {
    let settled = true
    let after: string | undefined
    do {
      const page = await store.list(guildId, { limit: BATCH, ...(after ? { after } : {}) })
      for (const device of page.subscriptions) {
        if (event.seq <= device.sinceSeq) {
          continue
        }
        const claim = await store.claimDelivery(guildId, sealId, device.endpoint, {
          ...lease,
          now: clock.now(),
        })
        if (claim === 'busy') {
          settled = false
        }
        if (claim !== 'claimed') {
          continue
        }
        try {
          if ((await notifier.send(device, { sealId, guildId })) === 'gone') {
            await store.drop(guildId, device.endpoint)
          } else {
            await store.completeDelivery(guildId, sealId, device.endpoint)
          }
        } catch (error) {
          if (error instanceof PushRejectedError) {
            await store.drop(guildId, device.endpoint)
          } else {
            await store.releaseDelivery(guildId, sealId, device.endpoint, clock.now())
            settled = false
          }
        }
      }
      after = page.next ?? undefined
    } while (after)
    return settled
  }

  const takeLease = () => ({ now: clock.now(), leaseMs: dispatchLeaseMs })

  /** One pass under the guild's dispatch lease. */
  async function pass(guildId: string): Promise<Status> {
    if (!(await store.acquireDispatchLease(guildId, holder, takeLease()))) {
      return 'busy'
    }
    try {
      for (;;) {
        const cursor = await store.cursor(guildId)
        const events = await db.withGuild(guildId, (tx) => eventsAfter(tx, cursor, BATCH))
        for (const event of events) {
          if (!(await store.acquireDispatchLease(guildId, holder, takeLease()))) {
            return 'busy'
          }
          if (event.type === 'seal.requested') {
            if (!(await notify(guildId, event, requested.parse(event.payload).sealId))) {
              throw new DeliveryPendingError()
            }
          }
          await store.advanceCursor(guildId, event.seq)
        }
        if (events.length < BATCH) {
          return 'done'
        }
      }
    } finally {
      await store.releaseDispatchLease(guildId, holder)
    }
  }

  const inflight = new Map<string, { dirty: boolean; promise: Promise<Status> }>()

  /** One in-flight dispatch per guild: a caller during a run marks it dirty and shares its result. */
  function attempt(guildId: string): Promise<Status> {
    const running = inflight.get(guildId)
    if (running) {
      running.dirty = true
      return running.promise
    }
    const entry: { dirty: boolean; promise: Promise<Status> } = {
      dirty: false,
      promise: Promise.resolve('done'),
    }
    entry.promise = withSlot(async () => {
      let status: Status
      do {
        entry.dirty = false
        status = await pass(guildId)
      } while (entry.dirty && status === 'done')
      return status
    }).finally(() => {
      inflight.delete(guildId)
    })
    inflight.set(guildId, entry)
    return entry.promise
  }

  return {
    /**
     * Scans the guild's log past its cursor and pushes each new Seal request once per device.
     * Returns at once when another holder has the guild's lease. Throws while a delivery is held back.
     */
    async dispatch(guildId: string): Promise<void> {
      await attempt(guildId)
    },
    /**
     * Dispatches whenever any guild's log grows, sweeps guilds whose cursor is behind their log
     * on start, and re-dispatches a guild after `retryMs` while its delivery is pending or busy
     * (one timer per guild); `onError` sees every failure.
     */
    async start(onError: (error: unknown) => void): Promise<{
      stop: () => Promise<void>
      retryTimers: () => number
    }> {
      const retryMs = deps.retryMs ?? 30_000
      const timers = new Map<string, ReturnType<typeof setTimeout>>()
      let stopped = false
      const schedule = (guildId: string) => {
        if (stopped || timers.has(guildId)) {
          return
        }
        const timer = setTimeout(() => {
          timers.delete(guildId)
          run(guildId)
        }, retryMs)
        timer.unref?.()
        timers.set(guildId, timer)
      }
      function run(guildId: string) {
        attempt(guildId).then(
          (status) => {
            if (status === 'busy') {
              schedule(guildId)
            }
          },
          (error: unknown) => {
            onError(error)
            schedule(guildId)
          }
        )
      }
      const sweep = async () => {
        let after: string | undefined
        for (;;) {
          const guilds = await store.guildsWithDevices(after, BATCH)
          for (const guildId of guilds) {
            const [cursor, head] = [
              await store.cursor(guildId),
              await db.withGuild(guildId, headSeq),
            ]
            if (cursor < head) {
              run(guildId)
            }
          }
          after = guilds.at(-1)
          if (guilds.length < BATCH) {
            return
          }
        }
      }
      const listening = await db.listen('guild_events', run, () => {
        sweep().catch(onError)
      })
      return {
        stop: async () => {
          stopped = true
          for (const timer of timers.values()) {
            clearTimeout(timer)
          }
          timers.clear()
          await listening.unlisten()
        },
        retryTimers: () => timers.size,
      }
    },
  }
}

/** The relay over its collaborators. */
export type SealPushRelay = ReturnType<typeof createSealPushRelay>
