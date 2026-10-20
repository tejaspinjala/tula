import type { Db } from '../db/client'
import type { AwaitingSealPage, AwaitingSealReader } from '../ports/awaiting-seal-reader'
import type { Clock } from '../ports/clock'

/** Postgres {@link AwaitingSealReader}: one join of held Quests to their latest Seal. */
export class PgAwaitingSealReader implements AwaitingSealReader {
  constructor(_db: Db, _clock: Clock) {}

  async due(_guildId: string, _page: { after?: string; limit: number }): Promise<AwaitingSealPage> {
    throw new Error('not implemented')
  }

  async hasWork(_guildId: string): Promise<boolean> {
    throw new Error('not implemented')
  }
}
