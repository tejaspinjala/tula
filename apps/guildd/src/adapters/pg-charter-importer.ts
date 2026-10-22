import type { Db } from '../db/client'
import type {
  CharterImporter,
  CharterImportInput,
  CharterImportOutcome,
} from '../ports/charter-import'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type { PgConfigStore } from './pg-config-store'
import type { PgRiteStore } from './pg-rite-store'

/** Postgres {@link CharterImporter}: config proposal, Rite drafts, event and idempotency row in one transaction. */
export class PgCharterImporter implements CharterImporter {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly config: PgConfigStore,
    private readonly rites: PgRiteStore,
    private readonly clock: Clock
  ) {}

  async importCharter(_guildId: string, _input: CharterImportInput): Promise<CharterImportOutcome> {
    void this.db
    void this.keys
    void this.config
    void this.rites
    void this.clock
    throw new Error('not implemented')
  }
}
