import type { RiteChangeKind } from '../rites/classify'
import type { RiteGraph } from '../rites/graph'

/** Largest page a {@link RiteStore} list returns. */
export const MAX_RITE_PAGE = 100

/** `active` versions may run; a `pending` (widening) version waits for confirmation. */
export type RiteVersionStatus = 'active' | 'pending'

/** What a save writes. The version number is assigned by the store. */
export interface NewRiteVersion {
  name: string
  graph: RiteGraph
  classification: RiteChangeKind
  status: RiteVersionStatus
}

/** One immutable version of a Rite (only `status` may move, pending to active). */
export interface RiteVersion extends NewRiteVersion {
  riteId: string
  /** 1-based, gap-free per Rite. */
  version: number
  createdAt: string
}

/** A Rite as listed: its latest version and the newest one that may run. */
export interface RiteSummary {
  id: string
  name: string
  latestVersion: number
  /** The newest `active` version, or null while every version is pending. */
  activeVersion: number | null
  updatedAt: string
}

/** One page of Rites in id order; `next` is the cursor for the following page. */
export interface RitePage {
  rites: RiteSummary[]
  next: string | null
}

/** One page of versions, newest first; `next` is the last version number returned when more remain. */
export interface RiteVersionPage {
  versions: RiteVersion[]
  next: number | null
}

/** A run of a pinned Rite version. Its Quests carry the instance id as their Campaign id. */
export interface RiteRun {
  id: string
  riteId: string
  version: number
  /** De-duplicates a retried run request: one key, one instance. */
  runKey: string
  createdAt: string
}

/** One page of instances in id order. */
export interface RiteRunPage {
  instances: RiteRun[]
  next: string | null
}

/**
 * Port for versioned Rites and their instances. Versions are immutable: a save appends the next
 * version, atomically, and only `status` moves (pending to active, idempotently). The store holds
 * no authority; Quests are posted by the engine through the normal queue.
 */
export interface RiteStore {
  /** Appends the next version of the Rite (creating it on the first), numbered without gaps. */
  saveVersion(guildId: string, riteId: string, input: NewRiteVersion): Promise<RiteVersion>
  /**
   * Saves version 1 only when the Rite has no version at all, atomically; returns it, or null
   * when one already exists. Used to seed templates without a check-then-write race.
   */
  seedVersion(guildId: string, riteId: string, input: NewRiteVersion): Promise<RiteVersion | null>
  /** The given version, or the latest of any status when `version` is omitted; null when absent. */
  getVersion(guildId: string, riteId: string, version?: number): Promise<RiteVersion | null>
  /** The newest `active` version, or null. */
  latestActive(guildId: string, riteId: string): Promise<RiteVersion | null>
  /** Marks a pending version active; idempotent for an active one; null when absent. */
  activate(guildId: string, riteId: string, version: number): Promise<RiteVersion | null>
  /** Rites in id order strictly after `after`. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<RitePage>
  /** Versions newest first, strictly below `before`. */
  versions(
    guildId: string,
    riteId: string,
    page: { before?: number; limit: number }
  ): Promise<RiteVersionPage>
  /** Creates the instance, or returns the existing one for the same `runKey` with `created: false`. */
  createInstance(
    guildId: string,
    input: { riteId: string; version: number; runKey: string }
  ): Promise<{ instance: RiteRun; created: boolean }>
  /** One instance, or null. */
  getInstance(guildId: string, id: string): Promise<RiteRun | null>
  /** Instances of a Rite in id order strictly after `after`. */
  listInstances(
    guildId: string,
    riteId: string,
    page: { after?: string; limit: number }
  ): Promise<RiteRunPage>
}
