import { z } from 'zod'
import type { Db } from './db/client'
import { eventsAfter } from './events'
import type { PushNotifier } from './ports/push-notifier'
import type { PushStore } from './ports/push-store'

/** Collaborators of {@link createSealPushRelay}. */
export interface SealPushDeps {
  db: Db
  store: PushStore
  notifier: PushNotifier
}

const BATCH = 100
const requested = z.object({ sealId: z.uuid() })

/**
 * Pushes the Guild Master's devices when a Seal is requested, driven by the `seal.requested`
 * events in the guild's log (the transactional outbox). A per-guild cursor in the store records
 * how far the log has been dispatched; a delivery claim per (Seal, device) makes a repeated or
 * concurrent dispatch send each push once. The push carries ids only: the client fetches the
 * Seal after the tap. Deterministic code; no model is involved.
 */
export function createSealPushRelay(deps: SealPushDeps) {
  const { db, store, notifier } = deps

  /** Pushes one Seal request to every device; throws after trying all if any send failed. */
  async function notify(guildId: string, sealId: string): Promise<void> {
    let failed: unknown
    let after: string | undefined
    do {
      const page = await store.list(guildId, { limit: BATCH, ...(after ? { after } : {}) })
      for (const device of page.subscriptions) {
        if (!(await store.claimDelivery(guildId, sealId, device.endpoint))) {
          continue
        }
        try {
          if ((await notifier.send(device, { sealId, guildId })) === 'gone') {
            await store.remove(guildId, device.endpoint)
          }
        } catch (error) {
          await store.releaseDelivery(guildId, sealId, device.endpoint)
          failed = error
        }
      }
      after = page.next ?? undefined
    } while (after)
    if (failed !== undefined) {
      throw failed
    }
  }

  async function dispatch(guildId: string): Promise<void> {
    for (;;) {
      const cursor = await store.cursor(guildId)
      const events = await db.withGuild(guildId, (tx) => eventsAfter(tx, cursor, BATCH))
      for (const event of events) {
        if (event.type === 'seal.requested') {
          await notify(guildId, requested.parse(event.payload).sealId)
        }
        await store.advanceCursor(guildId, event.seq)
      }
      if (events.length < BATCH) {
        return
      }
    }
  }

  return {
    /** Scans the guild's log past its cursor and pushes each new Seal request once per device. */
    dispatch,
    /** Dispatches whenever any guild's log grows; `onError` sees failures that a later wake retries. */
    async start(onError: (error: unknown) => void): Promise<{ stop: () => Promise<void> }> {
      const listening = await db.listen('guild_events', (guildId) => {
        dispatch(guildId).catch(onError)
      })
      return { stop: () => listening.unlisten() }
    },
  }
}

/** The relay over its collaborators. */
export type SealPushRelay = ReturnType<typeof createSealPushRelay>
