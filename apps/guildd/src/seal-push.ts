import { z } from 'zod'
import type { Db } from './db/client'
import { eventsAfter, type GuildEvent } from './events'
import type { Clock } from './ports/clock'
import { type PushNotifier, PushRejectedError } from './ports/push-notifier'
import type { PushStore } from './ports/push-store'

/** Collaborators and tuning of {@link createSealPushRelay}. */
export interface SealPushDeps {
  db: Db
  store: PushStore
  notifier: PushNotifier
  clock: Clock
  /** How long a claim may stay pending before a crashed sender's claim is retried; default 60 s. */
  leaseMs?: number | undefined
  /** Send attempts per (Seal, device) before that device is given up on; default 5. */
  maxAttempts?: number | undefined
  /** Delay before a live relay re-dispatches a guild whose delivery is still pending; default 30 s. */
  retryMs?: number | undefined
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

/**
 * Pushes the Guild Master's devices when a Seal is requested, driven by the `seal.requested`
 * events in the guild's log (the transactional outbox). One dispatch per guild runs at a time
 * (the store's dispatch lock). A per-guild cursor records how far the log is dispatched; a
 * leased claim per (Seal, device) makes repeats and crashes safe. A device added after an event
 * (its `sinceSeq`) never receives it. A device that can never be reached (bad key, refused,
 * dropped by the push service) is removed and does not hold the event back; a transient failure
 * holds the cursor until the device is delivered or its attempts run out. The push carries ids
 * only: the client fetches the Seal after the tap. Deterministic code; no model is involved.
 */
export function createSealPushRelay(deps: SealPushDeps) {
  const { db, store, notifier, clock } = deps
  const lease = { leaseMs: deps.leaseMs ?? 60_000, maxAttempts: deps.maxAttempts ?? 5 }

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
            await store.releaseDelivery(guildId, sealId, device.endpoint)
            settled = false
          }
        }
      }
      after = page.next ?? undefined
    } while (after)
    return settled
  }

  function dispatch(guildId: string): Promise<void> {
    return store.withDispatchLock(guildId, async () => {
      for (;;) {
        const cursor = await store.cursor(guildId)
        const events = await db.withGuild(guildId, (tx) => eventsAfter(tx, cursor, BATCH))
        for (const event of events) {
          if (event.type === 'seal.requested') {
            if (!(await notify(guildId, event, requested.parse(event.payload).sealId))) {
              throw new DeliveryPendingError()
            }
          }
          await store.advanceCursor(guildId, event.seq)
        }
        if (events.length < BATCH) {
          return
        }
      }
    })
  }

  return {
    /** Scans the guild's log past its cursor and pushes each new Seal request once per device. */
    dispatch,
    /**
     * Dispatches whenever any guild's log grows, and again after `retryMs` while a delivery is
     * pending; `onError` sees every failure.
     */
    async start(onError: (error: unknown) => void): Promise<{ stop: () => Promise<void> }> {
      const retryMs = deps.retryMs ?? 30_000
      const timers = new Set<ReturnType<typeof setTimeout>>()
      let stopped = false
      const run = (guildId: string) => {
        dispatch(guildId).catch((error: unknown) => {
          onError(error)
          if (stopped) {
            return
          }
          const timer = setTimeout(() => {
            timers.delete(timer)
            run(guildId)
          }, retryMs)
          timer.unref?.()
          timers.add(timer)
        })
      }
      const listening = await db.listen('guild_events', run)
      return {
        stop: async () => {
          stopped = true
          for (const timer of timers) {
            clearTimeout(timer)
          }
          await listening.unlisten()
        },
      }
    },
  }
}

/** The relay over its collaborators. */
export type SealPushRelay = ReturnType<typeof createSealPushRelay>
