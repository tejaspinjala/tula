import type {
  CharterImporter,
  CharterImportInput,
  CharterImportOutcome,
  CharterImportResult,
} from '../ports/charter-import'
import type { ConfigStore } from '../ports/config-store'
import type { RiteStore } from '../ports/rite-store'

/** An event the memory importer recorded. */
export interface MemoryCharterEvent {
  guildId: string
  type: string
  fact: Record<string, unknown>
}

/** Memory adapter for {@link CharterImporter}: all-or-nothing over a config store and a Rite store. */
export class MemoryCharterImporter implements CharterImporter {
  /** Events recorded, oldest first. */
  readonly events: MemoryCharterEvent[] = []
  private readonly results = new Map<string, CharterImportResult>()

  constructor(
    private readonly config: ConfigStore,
    private readonly rites: RiteStore
  ) {}

  async importCharter(_guildId: string, _input: CharterImportInput): Promise<CharterImportOutcome> {
    void this.config
    void this.rites
    void this.results
    throw new Error('not implemented')
  }
}
