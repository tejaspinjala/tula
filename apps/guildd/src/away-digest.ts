import { z } from 'zod'
import type { TenantTx } from './db/client'

/** The most entries one digest page returns. */
export const MAX_DIGEST_PAGE = 100

/** What happened while the Guild Master was away. */
export type DigestKind =
  | 'council_approved'
  | 'escalated'
  | 'council_halted'
  | 'seal_waiting'
  | 'quest_done'
  | 'spend'

/** One line of the "While you were away" scroll. Ids and small facts only. */
export interface DigestEntry {
  /** Seq of the event behind the line; also the page cursor. */
  seq: number
  kind: DigestKind
  occurredAt: string
  questId: string | null
  /** The Council session, for Council lines; opens its votes in the Council panel. */
  sessionId: string | null
  sealId: string | null
  /** Why the Council escalated (a reason code), else a coded Quest done reason. */
  reason: string | null
  /** Treasury spend: cents. */
  amountCents: number | null
  /** Treasury spend: the spend request's status. */
  status: string | null
}

/** The window the digest covers. `until` is null while it is still open (it runs to now). */
export interface DigestWindow {
  since: string
  until: string | null
  open: boolean
}

/** One page of the digest, oldest first; `next` is the cursor for the following page. */
export interface DigestPage {
  window: DigestWindow | null
  entries: DigestEntry[]
  next: number | null
  /** Cents the window's spends came to: each spend once, at its final amount, if reserved or settled. */
  spendTotalCents: number
}

const awayPayload = z.object({
  since: z.string().nullish(),
  until: z.string().nullish(),
})
const entryPayload = z.object({
  questId: z.string().optional(),
  sessionId: z.string().optional(),
  sealId: z.string().optional(),
  reason: z.string().optional(),
  amountCents: z.number().optional(),
  status: z.string().optional(),
})

const KINDS: Record<string, DigestKind> = {
  'council.approved': 'council_approved',
  'council.escalated': 'escalated',
  'council.halted': 'council_halted',
  'seal.requested': 'seal_waiting',
  'quest.done': 'quest_done',
  'treasury.spend': 'spend',
}

/** Events that end a Seal's wait, so it no longer counts as "still waiting". */
const SEAL_ENDS = ['seal.approved', 'seal.denied', 'seal.expired', 'seal.council_approved'] as const

function instant(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * Reads one page of the latest away window from the guild's event log. The window runs from the
 * latest `guildmaster.away` (back to the first away event of the same stretch, since extending a
 * return time appends another) to the next `guildmaster.returned`. When away mode lapsed by its
 * own `until` (no event is written then), the window ends at that `until`, even if the return tap
 * came later. With no end, it runs to `now`. Entries are the window's Council approvals and
 * escalations, Quests done, Treasury spend, and Seals requested in it that are still waiting.
 */
export async function awayDigest(
  tx: TenantTx,
  page: { after: number; limit: number },
  now: Date,
  sealWaiting: (sealId: string) => Promise<boolean>
): Promise<DigestPage> {
  const [latest] = await tx`
    select seq, payload, occurred_at from events
    where type = 'guildmaster.away' order by seq desc limit 1`
  if (!latest) {
    return { window: null, entries: [], next: null, spendTotalCents: 0 }
  }
  const away = awayPayload.parse(latest.payload)
  const awaySeq = Number(latest.seq)
  const since = away.since ?? new Date(latest.occurred_at).toISOString()
  const [first] = await tx`
    select min(seq) as seq from events
    where type = 'guildmaster.away' and seq <= ${awaySeq}
      and payload->>'since' is not distinct from ${away.since ?? null}`
  const startSeq = Number(first?.seq ?? awaySeq)
  const [back] = await tx`
    select seq, occurred_at from events
    where type = 'guildmaster.returned' and seq > ${awaySeq} order by seq limit 1`

  const untilMs = instant(away.until)
  const open = back === undefined && (untilMs === null || untilMs > now.getTime())
  // An open window has no time bound: it runs to the head of the log.
  const closes = [untilMs, back ? new Date(back.occurred_at).getTime() : null].filter(
    (ms): ms is number => ms !== null
  )
  const endIso = open ? '9999-12-31T23:59:59.999Z' : new Date(Math.min(...closes)).toISOString()
  const endSeq = back ? Number(back.seq) : Number.MAX_SAFE_INTEGER

  const rows = await tx`
    select e.seq, e.type, e.payload, e.occurred_at from events e
    where e.seq > ${Math.max(startSeq, page.after)} and e.seq < ${endSeq}
      and e.occurred_at <= ${endIso}
      and e.type in ${tx(Object.keys(KINDS))}
      and not (e.type = 'quest.done' and exists (
        select 1 from events a
        where a.type = 'council.approved' and a.seq > ${startSeq} and a.seq < ${endSeq}
          and a.payload->>'questId' = e.payload->>'questId'))
      and not (e.type = 'treasury.spend' and exists (
        select 1 from events n
        where n.type = 'treasury.spend' and n.seq > e.seq and n.seq < ${endSeq}
          and n.occurred_at <= ${endIso}
          and n.payload->>'spendId' = e.payload->>'spendId'))
      and not (e.type = 'seal.requested' and exists (
        select 1 from events r
        where r.seq > e.seq and r.type in ${tx([...SEAL_ENDS])}
          and r.payload->>'sealId' = e.payload->>'sealId'))
    order by e.seq limit ${page.limit + 1}`
  const [spent] = await tx`
    select coalesce(sum((e.payload->>'amountCents')::bigint), 0) as cents from events e
    where e.type = 'treasury.spend' and e.seq > ${startSeq} and e.seq < ${endSeq}
      and e.occurred_at <= ${endIso}
      and e.payload->>'status' in ('reserved', 'settled')
      and not exists (
        select 1 from events n
        where n.type = 'treasury.spend' and n.seq > e.seq and n.seq < ${endSeq}
          and n.occurred_at <= ${endIso}
          and n.payload->>'spendId' = e.payload->>'spendId')`
  const mapped = rows.slice(0, page.limit).flatMap((row): DigestEntry[] => {
    const kind = KINDS[String(row.type)]
    const p = entryPayload.safeParse(row.payload)
    if (!kind || !p.success) {
      return []
    }
    return [
      {
        seq: Number(row.seq),
        kind,
        occurredAt: new Date(row.occurred_at).toISOString(),
        questId: p.data.questId ?? null,
        sessionId: p.data.sessionId ?? null,
        sealId: p.data.sealId ?? null,
        reason: p.data.reason ?? null,
        amountCents: p.data.amountCents ?? null,
        status: p.data.status ?? null,
      },
    ]
  })
  // A Seal that lapsed or was decided without an event no longer waits: the Seal store has the last word.
  const live = await Promise.all(
    mapped.map(
      async (e) => e.kind !== 'seal_waiting' || (e.sealId !== null && (await sealWaiting(e.sealId)))
    )
  )
  const entries = mapped.filter((_, i) => live[i])
  return {
    window: { since, until: open ? null : endIso, open },
    entries,
    spendTotalCents: Number(spent?.cents ?? 0),
    next: rows.length > page.limit ? Number(rows[page.limit - 1]?.seq) || null : null,
  }
}
