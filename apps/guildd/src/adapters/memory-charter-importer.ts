import { canonicalJson } from '../audit-chain'
import { CHARTER_EVENT } from '../charters/events'
import type {
  CharterImporter,
  CharterImportInput,
  CharterImportOutcome,
  CharterImportResult,
} from '../ports/charter-import'
import { ConfigError, type ConfigStore } from '../ports/config-store'
import type { RiteStore } from '../ports/rite-store'

/** An event the memory importer recorded. */
export interface MemoryCharterEvent {
  guildId: string
  type: string
  fact: Record<string, unknown>
}

/**
 * Memory adapter for {@link CharterImporter}. Everything that can be refused (a stale base, a
 * locked Seal Policy) is checked by the config proposal before any Rite is written, and the
 * Rite drafts cannot fail, so the import is all or nothing as on Postgres.
 */
export class MemoryCharterImporter implements CharterImporter {
  /** Events recorded, oldest first. */
  readonly events: MemoryCharterEvent[] = []
  private readonly results = new Map<string, { hash: string; result: CharterImportResult }>()
  private readonly inFlight = new Map<string, Promise<CharterImportOutcome>>()

  constructor(
    private readonly config: ConfigStore,
    private readonly rites: RiteStore
  ) {}

  async importCharter(guildId: string, input: CharterImportInput): Promise<CharterImportOutcome> {
    // A same-tick duplicate waits for the first call, so one importId is never applied twice.
    const key = `${guildId}:${input.importId}`
    const running = this.inFlight.get(key)
    if (running) {
      await running
      return this.apply(guildId, key, input)
    }
    const run = this.apply(guildId, key, input)
    this.inFlight.set(key, run)
    try {
      return await run
    } finally {
      this.inFlight.delete(key)
    }
  }

  private async apply(
    guildId: string,
    key: string,
    input: CharterImportInput
  ): Promise<CharterImportOutcome> {
    const prior = this.results.get(key)
    const hash = input.requestHash
    if (prior) {
      return prior.hash === hash
        ? { ok: true, result: structuredClone(prior.result), replayed: true }
        : { ok: false, error: 'import_id_reused' }
    }
    try {
      const current = await this.config.current(guildId)
      if (input.baseVersion !== current.version) {
        return { ok: false, error: 'stale' }
      }
      let config: CharterImportResult['config']
      if (canonicalJson(current.config) === canonicalJson(input.config)) {
        config = { outcome: 'unchanged', version: current.version }
      } else {
        const proposed = await this.config.propose(guildId, input.config, {
          baseVersion: input.baseVersion,
        })
        config = {
          outcome: proposed.status === 'pending' ? 'pending' : 'applied',
          version: proposed.version,
        }
      }
      for (const draft of input.drafts) {
        await this.rites.saveVersion(guildId, draft.riteId, {
          name: draft.name,
          graph: draft.graph,
          classification: draft.classification,
          status: 'draft',
        })
      }
      const result: CharterImportResult = { config, riteIds: input.drafts.map((d) => d.riteId) }
      this.results.set(key, { hash, result: structuredClone(result) })
      this.events.push({
        guildId,
        type: CHARTER_EVENT.imported,
        fact: {
          importId: input.importId,
          outcome: config.outcome,
          version: config.version,
          rites: input.drafts.length,
        },
      })
      return { ok: true, result, replayed: false }
    } catch (error) {
      if (error instanceof ConfigError && error.code === 'stale') {
        return { ok: false, error: 'stale' }
      }
      if (error instanceof ConfigError && error.code === 'seal_policy_locked') {
        return { ok: false, error: 'seal_policy_locked' }
      }
      throw error
    }
  }
}
