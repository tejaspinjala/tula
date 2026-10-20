import type { Db } from './db/client'
import type { PushNotifier } from './ports/push-notifier'
import type { PushStore } from './ports/push-store'

/** Collaborators of {@link createSealPushRelay}. */
export interface SealPushDeps {
  db: Db
  store: PushStore
  notifier: PushNotifier
}

/**
 * Pushes the Guild Master's devices when a Seal is requested, driven by the `seal.requested`
 * events in the guild's log (the transactional outbox).
 */
export function createSealPushRelay(deps: SealPushDeps) {
  return {
    /** Scans the guild's log past its cursor and pushes each new Seal request once per device. */
    async dispatch(_guildId: string): Promise<void> {
      throw new Error(`not implemented ${typeof deps}`)
    },
    /** Dispatches whenever any guild's log grows; `onError` sees failures that a later wake retries. */
    async start(_onError: (error: unknown) => void): Promise<{ stop: () => Promise<void> }> {
      throw new Error('not implemented')
    },
  }
}

/** The relay over its collaborators. */
export type SealPushRelay = ReturnType<typeof createSealPushRelay>
