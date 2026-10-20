import type { Db } from '../db/client'
import { type CharacterLook, characterLook } from '../look-catalogue'
import type { GuildMasterLookStore } from '../ports/guild-master-look-store'

/** Postgres {@link GuildMasterLookStore}: one row per guild under forced RLS, saved by upsert. */
export class PgGuildMasterLookStore implements GuildMasterLookStore {
  constructor(private readonly db: Db) {}

  async get(guildId: string): Promise<CharacterLook | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`select look from guild_master_looks where guild_id = ${guildId}`
      return row ? characterLook.parse(row.look) : null
    })
  }

  async set(guildId: string, look: CharacterLook): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`
        insert into guild_master_looks (guild_id, look)
        values (${guildId}, ${tx.json({ ...look })})
        on conflict (guild_id) do update set look = excluded.look, updated_at = now()`
    })
  }
}
