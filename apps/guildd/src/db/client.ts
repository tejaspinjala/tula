import postgres, { type Sql, type TransactionSql } from 'postgres'
import { z } from 'zod'
import { extendChain } from '../audit-chain'
import type { KeyProvider } from '../ports/key-provider'

/** Thrown by `withGuild` when the guild id is not a UUID; nothing is queried. */
export class InvalidGuildIdError extends Error {
  constructor(value: string) {
    super(`invalid guild id: ${JSON.stringify(value)}`)
    this.name = 'InvalidGuildIdError'
  }
}

/** Thrown by `foundGuildChained` with `once` when a guild already exists; nothing was written. */
export class FoundingClosedError extends Error {
  constructor() {
    super('founding_closed')
    this.name = 'FoundingClosedError'
  }
}

const GUILD_ID = z.uuid()

/** A transaction on which tenant context is already set; the only handle that reaches tenant tables. */
export type TenantTx = TransactionSql

/** The app's database access: chained founding and tenant-scoped transactions, nothing else. */
export interface Db {
  /**
   * Founds a guild and chains its `guild.founded` event in ONE transaction, so a failure (for
   * example the KeyProvider being down) leaves no guild, event or chain entry behind.
   * `inFounding`, if given, runs in the same transaction after the chain is extended (tenant context
   * set), so what it writes commits or rolls back with the guild.
   * With `options.once`, the transaction first takes a transaction-scoped advisory lock and asks the
   * security-definer `any_guild_exists` (migration 0056); if a guild exists it throws
   * {@link FoundingClosedError}, so two concurrent foundings cannot both pass.
   * @returns the new guild's id.
   */
  foundGuildChained(
    input: { name: string; goal: string },
    keys: KeyProvider,
    inFounding?: (tx: TenantTx, guildId: string) => Promise<void>,
    options?: { once?: boolean }
  ): Promise<string>
  /**
   * Runs `fn` in a transaction whose tenant context is `guildId` (`set_config(..., true)`, so it
   * dies with the transaction and a reused pooled connection carries nothing over).
   * This is the only way the app queries tenant tables.
   */
  withGuild<T>(guildId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>
  /**
   * Like `withGuild` but on a small separate pool reserved for the live event stream, so streaming
   * can never starve HTTP routes of connections.
   */
  withGuildStream<T>(guildId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T>
  /**
   * LISTENs on `channel` over one dedicated connection (outside both pools). `onListening` fires
   * on the first subscription and after every reconnect, when notifications may have been missed.
   */
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListening?: () => void
  ): Promise<{ unlisten: () => Promise<void> }>
  /**
   * Counts one hit on a rate-limit bucket in ONE atomic upsert statement (no transaction). With
   * {@link Db.pruneRateLimits}, the only access to the `rate_limits` table, which is not tenant
   * data (see migration 0016): buckets are client addresses and guild ids, including unknown guilds.
   * @returns the hits in that window, this one included.
   */
  bumpRateLimit(bucket: string, windowStart: Date): Promise<number>
  /** Deletes rate-limit windows that started before `before`; a later hit starts a fresh count. */
  pruneRateLimits(before: Date): Promise<void>
  /**
   * Guild ids in the `push_guilds` registry (not tenant data, see migration 0041: opaque guild ids
   * only; `PgPushStore.add` writes the row in the subscription's own transaction), after `after`, in id order, at most `limit`. */
  pushGuilds(after: string | undefined, limit: number): Promise<string[]>
  /**
   * Guild ids (opaque, no tenant data) after `after`, in id order, at most `limit`, through the
   * security-definer `list_guild_ids` of migration 0043. Only a global bar needs it.
   */
  guildIds(after: string | undefined, limit: number): Promise<string[]>
  /**
   * Revokes every guild's live run tokens for good in one statement, through the security-definer
   * `revoke_all_run_tokens` of migration 0046; returns how many runs changed.
   */
  revokeAllRunTokens(): Promise<number>
  /**
   * Returns every guild's active Quests to the queue in one statement (lease cleared, deliverable
   * at once, `reason` as the last error), through the security-definer `release_all_leases` of
   * migration 0050; returns how many Quests changed.
   */
  releaseAllLeases(reason: string): Promise<number>
  /** Closes the pools. */
  close(): Promise<void>
}

/** Opens a pool as the non-owner app role (`url` must name that role, never the table owner). */
export function createDb(
  url: string,
  options: {
    max?: number
    streamMax?: number
    streamStatementTimeoutMs?: number
    /** Names this Db's sessions in `pg_stat_activity` (tests tell their own pool apart). */
    applicationName?: string
  } = {}
): Db {
  const sql: Sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    ...(options.applicationName === undefined
      ? {}
      : { connection: { application_name: options.applicationName } }),
  })
  // A hung fan-out query would otherwise hold one of the few stream connections forever and
  // stall every guild's stream, so the stream pool cancels statements after a bound.
  const streamSql: Sql = postgres(url, {
    max: options.streamMax ?? 2,
    onnotice: () => {},
    connection: {
      statement_timeout: options.streamStatementTimeoutMs ?? 10_000,
      ...(options.applicationName === undefined
        ? {}
        : { application_name: options.applicationName }),
    },
  })
  const scoped =
    (pool: Sql) =>
    async <T>(guildId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
      if (!GUILD_ID.safeParse(guildId).success) {
        throw new InvalidGuildIdError(guildId)
      }
      let outcome: { value: T } | undefined
      await pool.begin(async (tx) => {
        await tx`select set_config('app.guild_id', ${guildId}, true)`
        outcome = { value: await fn(tx) }
      })
      if (!outcome) {
        throw new Error('tenant transaction finished without running its callback')
      }
      return outcome.value
    }
  return {
    async foundGuildChained({ name, goal }, keys, inFounding, options) {
      let id: string | undefined
      await sql.begin(async (tx) => {
        if (options?.once) {
          await tx`select pg_advisory_xact_lock(hashtextextended('founding-lock', 0))`
          const [seen] = await tx`select any_guild_exists() as exists`
          if (z.object({ exists: z.boolean() }).parse(seen).exists) {
            throw new FoundingClosedError()
          }
        }
        const [row] = await tx`select found_guild(${name}, ${goal}) as id`
        const founded = String(row?.id)
        await tx`select set_config('app.guild_id', ${founded}, true)`
        await extendChain(tx, keys)
        await inFounding?.(tx, founded)
        id = founded
      })
      if (!id) {
        throw new Error('founding transaction finished without a guild')
      }
      return id
    },
    async bumpRateLimit(bucket, windowStart) {
      const [row] = await sql`insert into rate_limits (bucket, window_start, hits)
        values (${bucket}, ${windowStart}, 1)
        on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1
        returning hits`
      return z.coerce.number().parse(row?.hits)
    },
    async pruneRateLimits(before) {
      await sql`delete from rate_limits where window_start < ${before}`
    },
    async pushGuilds(after, limit) {
      const rows = await sql`select guild_id from push_guilds
        where (${after ?? null}::uuid is null or guild_id > ${after ?? null}::uuid)
        order by guild_id limit ${limit}`
      return rows.map((r) => z.string().parse(r.guild_id))
    },
    async guildIds(after, limit) {
      const rows = await sql`select list_guild_ids(${after ?? null}::uuid, ${limit}) as guild_id`
      return rows.map((r) => z.string().parse(r.guild_id))
    },
    async revokeAllRunTokens() {
      const [row] = await sql`select revoke_all_run_tokens() as revoked`
      return z.object({ revoked: z.number() }).parse(row).revoked
    },
    async releaseAllLeases(reason) {
      const [row] = await sql`select release_all_leases(${reason}) as released`
      return z.object({ released: z.number() }).parse(row).released
    },
    withGuild: scoped(sql),
    withGuildStream: scoped(streamSql),
    listen: (channel, onNotify, onListening) => sql.listen(channel, onNotify, onListening),
    close: async () => {
      await Promise.all([sql.end(), streamSql.end()])
    },
  }
}
