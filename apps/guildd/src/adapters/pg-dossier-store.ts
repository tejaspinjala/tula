import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import {
  type CreateDossierResult,
  type Dossier,
  type DossierPage,
  type DossierQuery,
  type DossierRequester,
  type DossierStore,
  dossierBodySchema,
  type NewDossier,
} from '../ports/dossier-store'
import type { KeyProvider } from '../ports/key-provider'

const row = z.object({
  dossier_id: z.string(),
  seq: z.coerce.number(),
  subject_quest_id: z.string(),
  subject_hall_id: z.string(),
  requested_by: z.enum(['member', 'guild_master']),
  requester_quest_id: z.string().nullable(),
  requester_hall_id: z.string().nullable(),
  requester_member: z.string().nullable(),
  body: dossierBodySchema,
  dossier_hash: z.string(),
  verified: z.boolean(),
  failed_checks: z.array(z.string()),
  created_at: z.coerce.date(),
})

function toDossier(r: unknown): Dossier {
  const d = row.parse(r)
  const requester: DossierRequester =
    d.requested_by === 'member' &&
    d.requester_quest_id !== null &&
    d.requester_hall_id !== null &&
    d.requester_member !== null
      ? {
          kind: 'member',
          questId: d.requester_quest_id,
          hallId: d.requester_hall_id,
          memberId: d.requester_member,
        }
      : { kind: 'guild_master' }
  return {
    id: d.dossier_id,
    seq: d.seq,
    subjectQuestId: d.subject_quest_id,
    subjectHallId: d.subject_hall_id,
    requester,
    body: d.body,
    hash: d.dossier_hash,
    verified: d.verified,
    failedChecks: d.failed_checks,
    createdAt: d.created_at.toISOString(),
  }
}

/**
 * Postgres {@link DossierStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild.
 * A create by a Member takes a per-Quest advisory lock, so the cap holds under concurrent
 * requests, and appends `dossier.created` (ids and hashes only, never the body) to the audit
 * chain in the same transaction.
 */
export class PgDossierStore implements DossierStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async create(guildId: string, input: NewDossier): Promise<CreateDossierResult> {
    const { requester } = input
    return this.db.withGuild(guildId, async (tx) => {
      if (requester.kind === 'member') {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`dossier:${guildId}:${requester.questId}`}, 0))`
        if (input.maxPerQuest !== undefined) {
          const [count] = await tx`
            select count(*)::int as n from dossiers
            where guild_id = ${guildId} and requester_quest_id = ${requester.questId}`
          if (z.object({ n: z.number() }).parse(count).n >= input.maxPerQuest) {
            return { ok: false, error: 'dossier_cap' }
          }
        }
      }
      const [created] = await tx`
        insert into dossiers (guild_id, subject_quest_id, subject_hall_id, requested_by,
          requester_quest_id, requester_hall_id, requester_member, body, dossier_hash, verified,
          failed_checks, created_at)
        values (${guildId}, ${input.subjectQuestId}, ${input.subjectHallId}, ${requester.kind},
          ${requester.kind === 'member' ? requester.questId : null},
          ${requester.kind === 'member' ? requester.hallId : null},
          ${requester.kind === 'member' ? requester.memberId : null},
          ${tx.json(dossierBodySchema.parse(input.body))}, ${input.hash}, ${input.verified},
          ${tx.json(input.failedChecks)}, ${input.at})
        returning *`
      const dossier = toDossier(created)
      await appendEvent(tx, this.keys, 'dossier.created', {
        dossierId: dossier.id,
        subjectQuestId: dossier.subjectQuestId,
        subjectHall: dossier.subjectHallId,
        requesterHall: requester.kind === 'member' ? requester.hallId : null,
        hash: dossier.hash,
        verified: dossier.verified,
      })
      return { ok: true, dossier }
    })
  }

  async countForQuest(guildId: string, questId: string): Promise<number> {
    if (!z.uuid().safeParse(questId).success) {
      return 0
    }
    const [row] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select count(*)::int as n from dossiers
        where guild_id = ${guildId} and requester_quest_id = ${questId}`
    )
    return z.object({ n: z.number() }).parse(row).n
  }

  async get(guildId: string, id: string): Promise<Dossier | null> {
    if (!z.uuid().safeParse(id).success) {
      return null
    }
    const [found] = await this.db.withGuild(
      guildId,
      (tx) => tx`select * from dossiers where guild_id = ${guildId} and dossier_id = ${id}`
    )
    return found ? toDossier(found) : null
  }

  async list(guildId: string, query: DossierQuery): Promise<DossierPage> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select * from dossiers
        where guild_id = ${guildId}
          and (subject_hall_id = ${query.hallId} or requester_hall_id = ${query.hallId})
          and (${query.after ?? null}::bigint is null or seq < ${query.after ?? null})
        order by seq desc
        limit ${query.limit + 1}`
    )
    const page = rows.slice(0, query.limit).map(toDossier)
    const last = page.at(-1)
    return { dossiers: page, next: rows.length > query.limit && last ? last.seq : null }
  }
}
