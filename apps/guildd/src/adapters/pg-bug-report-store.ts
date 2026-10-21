import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import {
  type BugReport,
  type BugReportFiler,
  type BugReportPage,
  type BugReportQuery,
  type BugReportStore,
  type FileBugReportResult,
  type NewBugReport,
  reproduction,
  reproductionHash,
} from '../ports/bug-report-store'
import type { KeyProvider } from '../ports/key-provider'
import type { PgQuestQueue } from './pg-quest-queue'

const row = z.object({
  bug_report_id: z.string(),
  seq: z.coerce.number(),
  owning_hall: z.string(),
  title: z.string(),
  reproduction,
  reproduction_hash: z.string(),
  evidence: z.array(z.string()),
  filed_by: z.enum(['member', 'guild_master']),
  filer_quest_id: z.string().nullable(),
  filer_hall_id: z.string().nullable(),
  filer_member: z.string().nullable(),
  status: z.enum(['open', 'duplicate', 'fixed']),
  duplicate_of: z.string().nullable(),
  fix_quest_id: z.string().nullable(),
  fix_handoff_hash: z.string().nullable(),
  created_at: z.coerce.date(),
  fixed_at: z.coerce.date().nullable(),
})

function toReport(r: unknown): BugReport {
  const b = row.parse(r)
  const filer: BugReportFiler =
    b.filed_by === 'member' &&
    b.filer_quest_id !== null &&
    b.filer_hall_id !== null &&
    b.filer_member !== null
      ? {
          kind: 'member',
          questId: b.filer_quest_id,
          hallId: b.filer_hall_id,
          memberId: b.filer_member,
        }
      : { kind: 'guild_master' }
  return {
    id: b.bug_report_id,
    seq: b.seq,
    owningHall: b.owning_hall,
    title: b.title,
    reproduction: b.reproduction,
    reproductionHash: b.reproduction_hash,
    evidence: b.evidence,
    filer,
    status: b.status,
    duplicateOf: b.duplicate_of,
    fixQuestId: b.fix_quest_id,
    fixHandoffHash: b.fix_handoff_hash,
    createdAt: b.created_at.toISOString(),
    fixedAt: b.fixed_at?.toISOString() ?? null,
  }
}

/**
 * Postgres {@link BugReportStore}: every call runs in `Db.withGuild`, so RLS scopes it to one
 * guild. A filing takes a per-guild advisory lock (so the cap and the one-open-per-defect rule
 * hold under concurrent filings), posts the Fix Quest in the same transaction through
 * {@link PgQuestQueue.postIn}, and appends `bug_report.filed` or `bug_report.duplicate` (ids and
 * hashes only, never any text) to the audit chain before it commits.
 */
export class PgBugReportStore implements BugReportStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly quests: PgQuestQueue
  ) {}

  async file(guildId: string, input: NewBugReport): Promise<FileBugReportResult> {
    const { filer } = input
    const hash = reproductionHash(input.owningHall, input.reproduction)
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`bug-reports:${guildId}`}, 0))`
      if (filer.kind === 'member' && input.maxPerQuest !== undefined) {
        const [count] = await tx`
          select count(*)::int as n from bug_reports
          where guild_id = ${guildId} and filer_quest_id = ${filer.questId}`
        if (z.object({ n: z.number() }).parse(count).n >= input.maxPerQuest) {
          return { ok: false, error: 'bug_report_cap' }
        }
      }
      const [open] = await tx`
        select bug_report_id from bug_reports
        where guild_id = ${guildId} and owning_hall = ${input.owningHall}
          and reproduction_hash = ${hash} and status = 'open'`
      const openId = open ? z.object({ bug_report_id: z.string() }).parse(open).bug_report_id : null
      const posted = openId === null ? await this.quests.postIn(tx, guildId, input.fixQuest) : null
      const [created] = await tx`
        insert into bug_reports (guild_id, owning_hall, title, reproduction, reproduction_hash,
          evidence, filed_by, filer_quest_id, filer_hall_id, filer_member, status, duplicate_of,
          fix_quest_id, created_at)
        values (${guildId}, ${input.owningHall}, ${input.title}, ${tx.json(input.reproduction)},
          ${hash}, ${tx.json(input.evidence)}, ${filer.kind},
          ${filer.kind === 'member' ? filer.questId : null},
          ${filer.kind === 'member' ? filer.hallId : null},
          ${filer.kind === 'member' ? filer.memberId : null},
          ${openId === null ? 'open' : 'duplicate'}, ${openId},
          ${posted?.quest.id ?? null}, ${input.at})
        returning *`
      const report = toReport(created)
      await appendEvent(
        tx,
        this.keys,
        openId === null ? 'bug_report.filed' : 'bug_report.duplicate',
        openId === null
          ? {
              bugReportId: report.id,
              fixQuestId: report.fixQuestId,
              owningHall: report.owningHall,
              reproductionHash: hash,
            }
          : { bugReportId: report.id, duplicateOf: openId, owningHall: report.owningHall }
      )
      return { ok: true, report, fixQuest: posted?.quest ?? null }
    })
  }

  async countForQuest(guildId: string, questId: string): Promise<number> {
    if (!z.uuid().safeParse(questId).success) {
      return 0
    }
    const [found] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select count(*)::int as n from bug_reports
        where guild_id = ${guildId} and filer_quest_id = ${questId}`
    )
    return z.object({ n: z.number() }).parse(found).n
  }

  async get(guildId: string, id: string): Promise<BugReport | null> {
    if (!z.uuid().safeParse(id).success) {
      return null
    }
    const [found] = await this.db.withGuild(
      guildId,
      (tx) => tx`select * from bug_reports where guild_id = ${guildId} and bug_report_id = ${id}`
    )
    return found ? toReport(found) : null
  }

  async forFixQuest(guildId: string, questId: string): Promise<BugReport | null> {
    if (!z.uuid().safeParse(questId).success) {
      return null
    }
    const [found] = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select * from bug_reports where guild_id = ${guildId} and fix_quest_id = ${questId}`
    )
    return found ? toReport(found) : null
  }

  async list(guildId: string, query: BugReportQuery): Promise<BugReportPage> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select * from bug_reports
        where guild_id = ${guildId} and owning_hall = ${query.hallId}
          and (${query.status ?? null}::text is null or status = ${query.status ?? null})
          and (${query.after ?? null}::bigint is null or seq < ${query.after ?? null})
        order by seq desc
        limit ${query.limit + 1}`
    )
    const page = rows.slice(0, query.limit).map(toReport)
    const last = page.at(-1)
    return { reports: page, next: rows.length > query.limit && last ? last.seq : null }
  }
}
