import type { Db } from '../db/client'
import type { KeyProvider } from '../ports/key-provider'
import type {
  MissivePage,
  MissiveQuery,
  MissiveStore,
  NewMissive,
  SendResult,
} from '../ports/missive-store'

/** Postgres {@link MissiveStore}. */
export class PgMissiveStore implements MissiveStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async send(_guildId: string, _input: NewMissive): Promise<SendResult> {
    throw new Error(`not implemented ${typeof this.db} ${typeof this.keys}`)
  }

  async list(_guildId: string, _query: MissiveQuery): Promise<MissivePage> {
    throw new Error('not implemented')
  }
}
