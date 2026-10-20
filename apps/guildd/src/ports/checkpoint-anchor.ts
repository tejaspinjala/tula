import { z } from 'zod'

/**
 * A signed statement of an audit chain's head, kept outside Postgres. The signature is the
 * KeyProvider MAC of `<guildId>:<seq>:<mac>` under the `audit-checkpoint` purpose, so whoever holds
 * only database access can neither forge nor silently drop one.
 */
export const anchoredCheckpoint = z.object({
  seq: z.number().int().min(1),
  mac: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
})

/** See {@link anchoredCheckpoint}. */
export type AnchoredCheckpoint = z.infer<typeof anchoredCheckpoint>

/**
 * Append-only custody of signed chain-head checkpoints outside Postgres, per guild. It is what
 * makes truncation of the chain's tail detectable: the database can lose its newest entries, but
 * not the anchor's copy of a head it once vouched for.
 */
export interface CheckpointAnchor {
  /** Records `checkpoint` for `guildId`. Idempotent for the same seq and MAC; never removes older ones. */
  publish(guildId: string, checkpoint: AnchoredCheckpoint): Promise<void>
  /** The anchored checkpoint with the highest seq for `guildId`, or null when there is none. */
  latest(guildId: string): Promise<AnchoredCheckpoint | null>
}
