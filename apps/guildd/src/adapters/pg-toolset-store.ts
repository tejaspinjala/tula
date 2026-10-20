import { z } from 'zod'
import type { Db } from '../db/client'
import type { ToolsetStore } from '../ports/toolset-store'

const tools = z.array(z.string())

/** Postgres {@link ToolsetStore}: the insert is `on conflict do nothing`, so the first freeze wins. */
export class PgToolsetStore implements ToolsetStore {
  constructor(private readonly db: Db) {}

  async freeze(
    guildId: string,
    scope: string,
    role: string,
    list: readonly string[]
  ): Promise<string[]> {
    return this.db.withGuild(guildId, async (tx) => {
      await tx`
        insert into campaign_toolsets (guild_id, scope, role, tools)
        values (${guildId}, ${scope}, ${role}, ${tx.json([...list])})
        on conflict (guild_id, scope, role) do nothing`
      const [stored] = await tx`
        select tools from campaign_toolsets
        where guild_id = ${guildId} and scope = ${scope} and role = ${role}`
      return tools.parse(stored?.tools)
    })
  }
}
