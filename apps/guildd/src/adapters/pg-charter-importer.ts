import type { JSONValue } from 'postgres'
import { z } from 'zod'
import { canonicalJson } from '../audit-chain'
import { CHARTER_EVENT } from '../charters/events'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type {
  CharterImporter,
  CharterImportInput,
  CharterImportOutcome,
  CharterImportResult,
} from '../ports/charter-import'
import type { Clock } from '../ports/clock'
import { ConfigError } from '../ports/config-store'
import type { KeyProvider } from '../ports/key-provider'
import type { PgConfigStore } from './pg-config-store'
import type { PgRiteStore } from './pg-rite-store'

const storedResult = z.object({
  config: z.object({
    outcome: z.enum(['applied', 'pending', 'unchanged']),
    version: z.number().int(),
  }),
  riteIds: z.array(z.string()),
})

/** A result is plain JSON; this narrows it to the driver's JSON type without a cast. */
function toJson(result: CharterImportResult): JSONValue {
  return JSON.parse(JSON.stringify(result))
}

/**
 * Postgres {@link CharterImporter}: the config proposal, the Rite drafts, the `charter.imported`
 * event and the idempotency row share one `Db.withGuild` transaction, so any failure leaves none
 * of them behind. The config and Rite writes reuse the stores' own SQL on that transaction.
 */
export class PgCharterImporter implements CharterImporter {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly config: PgConfigStore,
    private readonly rites: PgRiteStore,
    private readonly clock: Clock
  ) {}

  async importCharter(guildId: string, input: CharterImportInput): Promise<CharterImportOutcome> {
    try {
      return await this.db.withGuild(guildId, async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`charter-import:${guildId}:${input.importId}`}, 0))`
        const [prior] = await tx`
          select result, input_hash from charter_imports
          where guild_id = ${guildId} and import_id = ${input.importId}`
        const hash = input.requestHash
        if (prior) {
          if (prior.input_hash !== hash) {
            return { ok: false as const, error: 'import_id_reused' as const }
          }
          return { ok: true as const, result: storedResult.parse(prior.result), replayed: true }
        }
        const current = await this.config.currentIn(tx, guildId)
        if (input.baseVersion !== current.version) {
          throw new ConfigError('stale', input.baseVersion)
        }
        let config: CharterImportResult['config']
        if (canonicalJson(current.config) === canonicalJson(input.config)) {
          config = { outcome: 'unchanged', version: current.version }
        } else {
          const proposed = await this.config.proposeIn(tx, guildId, input.config, {
            baseVersion: input.baseVersion,
          })
          config = {
            outcome: proposed.status === 'pending' ? 'pending' : 'applied',
            version: proposed.version,
          }
        }
        for (const draft of input.drafts) {
          await this.rites.saveVersionIn(tx, guildId, draft.riteId, {
            name: draft.name,
            graph: draft.graph,
            classification: draft.classification,
            status: 'draft',
          })
        }
        const result: CharterImportResult = {
          config,
          riteIds: input.drafts.map((d) => d.riteId),
        }
        await appendEvent(tx, this.keys, CHARTER_EVENT.imported, {
          importId: input.importId,
          outcome: config.outcome,
          version: config.version,
          rites: input.drafts.length,
        })
        await tx`
          insert into charter_imports (guild_id, import_id, input_hash, result, created_at)
          values (${guildId}, ${input.importId}, ${hash}, ${tx.json(toJson(result))},
            ${this.clock.now()})`
        return { ok: true as const, result, replayed: false }
      })
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
