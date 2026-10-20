import postgres, { type Sql, type TransactionSql } from 'postgres'
import { z } from 'zod'

/** Thrown by `withGuild` when the guild id is not a UUID; nothing is queried. */
export class InvalidGuildIdError extends Error {
  constructor(value: string) {
    super(`invalid guild id: ${JSON.stringify(value)}`)
    this.name = 'InvalidGuildIdError'
  }
}

const GUILD_ID = z.uuid()

/** A transaction on which tenant context is already set; the only handle that reaches tenant tables. */
export type TenantTx = TransactionSql

/** The app's database access: founding and tenant-scoped transactions, nothing else. */
export interface Db {
  /**
   * Founds a guild. Founding has no tenant yet, so this calls the owner-side `found_guild`
   * function (security definer) rather than inserting under a tenant context.
   * @returns the new guild's id.
   */
  foundGuild(input: { name: string; goal: string }): Promise<string>
  /**
   * Runs `fn` in a transaction whose tenant context is `guildId` (`set_config(..., true)`, so it
   * dies with the transaction and a reused pooled connection carries nothing over).
   * This is the only way the app queries tenant tables.
   */
  withGuild<T>(guildId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>
  /** Closes the pool. */
  close(): Promise<void>
}

/** Opens a pool as the non-owner app role (`url` must name that role, never the table owner). */
export function createDb(url: string, options: { max?: number } = {}): Db {
  const sql: Sql = postgres(url, { max: options.max ?? 10, onnotice: () => {} })
  return {
    async foundGuild({ name, goal }) {
      const [row] = await sql`select found_guild(${name}, ${goal}) as id`
      return String(row?.id)
    },
    withGuild: async <T>(guildId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
      if (!GUILD_ID.safeParse(guildId).success) {
        throw new InvalidGuildIdError(guildId)
      }
      const result = await sql.begin(async (tx) => {
        await tx`select set_config('app.guild_id', ${guildId}, true)`
        return fn(tx)
      })
      return result as T
    },
    close: () => sql.end(),
  }
}
