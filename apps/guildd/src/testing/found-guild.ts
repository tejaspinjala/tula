import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import type { Db } from '../db/client'
import type { KeyProvider } from '../ports/key-provider'

/**
 * Test-only founding: goes through `Db.foundGuildChained`, so the guild's `guild.founded` event is
 * chained exactly as in production. Config is left unseeded (tests seed it when they need it), so
 * the event log holds only `guild.founded`. `keys` defaults to a fresh memory provider.
 * @returns the new guild's id.
 */
export function foundTestGuild(
  db: Db,
  input: { name: string; goal: string },
  keys: KeyProvider = new MemoryKeyProvider()
): Promise<string> {
  return db.foundGuildChained(input, keys)
}
