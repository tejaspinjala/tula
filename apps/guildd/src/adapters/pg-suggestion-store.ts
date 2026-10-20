import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type {
  DecideResult,
  NewSuggestion,
  Suggestion,
  SuggestionPage,
  SuggestionStatus,
  SuggestionStore,
} from '../ports/suggestion-store'

const date = z.date().transform((d) => d.toISOString())
const row = z.object({
  suggestion_id: z.string(),
  source_id: z.string(),
  repo: z.string(),
  kind: z.enum(['pr', 'adr']),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  status: z.enum(['pending', 'accepted', 'dismissed']),
  note_id: z.string().nullable(),
  created_at: date,
  decided_at: date.nullable(),
})

const COLUMNS = `suggestion_id, source_id, repo, kind, title, body, url, status, note_id, created_at, decided_at`

function toSuggestion(raw: unknown): Suggestion {
  const r = row.parse(raw)
  return {
    id: r.suggestion_id,
    sourceId: r.source_id,
    repo: r.repo,
    kind: r.kind,
    title: r.title,
    body: r.body,
    url: r.url,
    status: r.status,
    noteId: r.note_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }
}

/**
 * Postgres {@link SuggestionStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild).
 * The unique `(guild_id, source_id)` key is what keeps a decided suggestion from coming back, and the
 * decision is one conditional UPDATE, so of two racing decisions exactly one wins.
 */
export class PgSuggestionStore implements SuggestionStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  async addMany(guildId: string, items: readonly NewSuggestion[]): Promise<number> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      let added = 0
      for (const item of items) {
        const inserted = await tx`
          insert into learning_suggestions
            (guild_id, source_id, repo, kind, title, body, url, created_at)
          values (${guildId}, ${item.sourceId}, ${item.repo}, ${item.kind}, ${item.title},
            ${item.body}, ${item.url}, ${now})
          on conflict (guild_id, source_id) do nothing
          returning suggestion_id`
        added += inserted.length
      }
      return added
    })
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number; status?: SuggestionStatus }
  ): Promise<SuggestionPage> {
    const after = page.after ?? null
    const status = page.status ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select ${tx.unsafe(COLUMNS)} from learning_suggestions
        where guild_id = ${guildId}
          and (${after}::uuid is null or suggestion_id > ${after}::uuid)
          and (${status}::text is null or status = ${status}::text)
        order by suggestion_id limit ${page.limit + 1}`
      const all = rows.map(toSuggestion)
      const suggestions = all.slice(0, page.limit)
      const last = suggestions.at(-1)
      return { suggestions, next: all.length > page.limit && last ? last.id : null }
    })
  }

  async get(guildId: string, id: string): Promise<Suggestion | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [found] = await tx`
        select ${tx.unsafe(COLUMNS)} from learning_suggestions
        where guild_id = ${guildId} and suggestion_id = ${id}::uuid`
      return found ? toSuggestion(found) : null
    })
  }

  async decide(
    guildId: string,
    id: string,
    status: 'accepted' | 'dismissed'
  ): Promise<DecideResult> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const [updated] = await tx`
        update learning_suggestions set status = ${status}, decided_at = ${now}
        where guild_id = ${guildId} and suggestion_id = ${id}::uuid and status = 'pending'
        returning ${tx.unsafe(COLUMNS)}`
      if (updated) {
        const suggestion = toSuggestion(updated)
        // Ids only: never the title, body, URL or any token.
        await appendEvent(
          tx,
          this.keys,
          status === 'accepted' ? 'learning.accepted' : 'learning.dismissed',
          { suggestionId: suggestion.id, sourceId: suggestion.sourceId }
        )
        return { ok: true, suggestion }
      }
      const [existing] = await tx`
        select suggestion_id from learning_suggestions
        where guild_id = ${guildId} and suggestion_id = ${id}::uuid`
      return { ok: false, reason: existing ? 'already_decided' : 'not_found' }
    })
  }

  async recordNote(guildId: string, id: string, noteId: string): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`
        update learning_suggestions set note_id = ${noteId}::uuid
        where guild_id = ${guildId} and suggestion_id = ${id}::uuid and status = 'accepted'`
    })
  }

  async reopen(guildId: string, id: string): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`
        update learning_suggestions set status = 'pending', decided_at = null
        where guild_id = ${guildId} and suggestion_id = ${id}::uuid
          and status = 'accepted' and note_id is null`
    })
  }
}
