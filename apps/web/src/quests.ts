import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const QUEST_STATES = ['queued', 'active', 'awaiting_seal', 'done', 'dead'] as const

const questBody = z.object({
  id: z.string(),
  title: z.string(),
  hallId: z.string(),
  ownerId: z.string(),
  state: z.enum(QUEST_STATES),
  doneCondition: z.string(),
  round: z.number(),
  roundLimit: z.number(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  campaignId: z.string().nullable().default(null),
  dataClass: z.enum(['public', 'internal', 'private']).default('internal'),
  blockReason: z
    .enum([
      'hall_not_found',
      'hall_locked',
      'private_provider_unavailable',
      'budget_exhausted',
      'no_provider_available',
    ])
    .nullable()
    .default(null),
})
const linkBody = z.object({ parentId: z.string(), childId: z.string() })
const pageBody = z.object({
  quests: z.array(questBody),
  next: z.string().nullable(),
  links: z.array(linkBody).default([]),
})

/** A Quest as the Quest Board shows it; `parentId` is set on a Sub-Quest. */
export type BoardQuest = z.infer<typeof questBody> & { parentId: string | null }

/** The Sub-Quests of `parentId` among `quests`, in board order. */
export function childrenOf(quests: readonly BoardQuest[], parentId: string): BoardQuest[] {
  return quests.filter((q) => q.parentId === parentId)
}
/** The Campaigns present on the board, each once, sorted; Quests with no Campaign add none. */
export function campaignsOf(quests: readonly BoardQuest[]): string[] {
  return [...new Set(quests.flatMap((q) => (q.campaignId === null ? [] : [q.campaignId])))].sort()
}

/** The Quests of one Campaign in board order, or all of them when `campaignId` is null. */
export function inCampaign(quests: readonly BoardQuest[], campaignId: string | null): BoardQuest[] {
  return campaignId === null ? [...quests] : quests.filter((q) => q.campaignId === campaignId)
}

/** The Member who claimed a Quest (its owner, once it has been leased at least once), or null while unclaimed. */
export function claimerOf(quest: BoardQuest): string | null {
  // A queued Quest holds no lease (never claimed, or its claim was released), whatever its attempts.
  return quest.attempts > 0 && quest.state !== 'queued' ? quest.ownerId : null
}

/** The Quest Board's columns, in lifecycle order. */
export const BOARD_STATES = QUEST_STATES

/** Most pages one load will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

/** Loads the guild's Quests (or its dead-letter list), following the server's page cursors. */
export async function loadQuests(
  session: Session,
  fetcher: Fetcher,
  options: { limit?: number; deadLetters?: boolean } = {}
): Promise<BoardQuest[]> {
  const loaded: z.infer<typeof questBody>[] = []
  const parents = new Map<string, string>()
  const limit = options.limit ?? 50
  const path = `/api/guilds/${session.guildId}/quests${options.deadLetters ? '/dead-letters' : ''}`
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `limit=${limit}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`
    const res = await fetcher(`${path}?${query}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(data)
      throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
    }
    const body = pageBody.parse(data)
    loaded.push(...body.quests)
    for (const link of body.links) {
      parents.set(link.childId, link.parentId)
    }
    if (body.next === null) {
      return loaded.map((q) => ({ ...q, parentId: parents.get(q.id) ?? null }))
    }
    after = body.next
  }
  throw new Error('too many Quest pages')
}

/** Splits Quests into one list per state, so the board renders a column each. */
export function groupByState(
  quests: readonly BoardQuest[]
): Record<BoardQuest['state'], BoardQuest[]> {
  const board: Record<BoardQuest['state'], BoardQuest[]> = {
    queued: [],
    active: [],
    awaiting_seal: [],
    done: [],
    dead: [],
  }
  for (const quest of quests) {
    board[quest.state].push(quest)
  }
  return board
}

/** Trades the session for a single-use stream ticket (a browser socket cannot send headers). */
export async function fetchStreamTicket(session: Session, fetcher: Fetcher): Promise<string> {
  const res = await fetcher(`/api/guilds/${session.guildId}/events/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return z.object({ ticket: z.string() }).parse(data).ticket
}

/** The event-stream URL: the cursor and a single-use ticket; the session token never goes in a URL. */
export function questStreamUrl(
  session: Session,
  origin: string,
  lastSeq: number,
  ticket: string
): string {
  const url = new URL(`/api/guilds/${session.guildId}/events`, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('last_seq', String(lastSeq))
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

const frame = z.union([
  z.object({
    type: z.literal('event'),
    event: z.object({ type: z.string(), seq: z.number() }),
  }),
  z.object({ type: z.literal('snapshot') }),
])

/**
 * Reads one stream frame: whether the board should refresh, and the event's seq (the cursor to
 * resume from). Quest events and the connect snapshot refresh; other events only move the cursor.
 */
export function readQuestFrame(raw: string): { refresh: boolean; seq: number | null } {
  let data: unknown = null
  try {
    data = JSON.parse(raw)
  } catch {
    return { refresh: false, seq: null }
  }
  const parsed = frame.safeParse(data)
  if (!parsed.success) {
    return { refresh: false, seq: null }
  }
  if (parsed.data.type === 'snapshot') {
    return { refresh: true, seq: null }
  }
  return { refresh: parsed.data.event.type.startsWith('quest.'), seq: parsed.data.event.seq }
}

/** Which round a Quest is on, for display. */
export function roundText(quest: Pick<BoardQuest, 'round' | 'roundLimit'>): string {
  const round = Math.min(Math.max(quest.round, 1), quest.roundLimit)
  return `Round ${round} of ${quest.roundLimit}`
}

/** A Quest template the Guild Master can post from (mirrors guildd's code-defined templates). */
export interface QuestTemplateChoice {
  id: string
  name: string
  hallId: string
  hallName: string
}

/** The templates the post form offers, by Hall. */
export const QUEST_TEMPLATES: readonly QuestTemplateChoice[] = [
  { id: 'herald-brief', name: 'Herald brief', hallId: 'heralds', hallName: 'Heralds Hall' },
  {
    id: 'herald-announcement',
    name: 'Herald announcement',
    hallId: 'heralds',
    hallName: 'Heralds Hall',
  },
  { id: 'health-log', name: 'Health log', hallId: 'health', hallName: 'Health' },
  { id: 'personal-plan', name: 'Personal plan', hallId: 'personal', hallName: 'Personal' },
  {
    id: 'relationship-note',
    name: 'Relationship note',
    hallId: 'relationships',
    hallName: 'Relationships',
  },
]

/** Posts a Quest from a template (`POST /guilds/:id/quests`); `jobKey` makes a retry harmless. */
export async function postQuest(
  session: Session,
  input: { templateId: string; title: string; jobKey: string },
  fetcher: Fetcher
): Promise<BoardQuest> {
  const res = await fetcher(`/api/guilds/${session.guildId}/quests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return { ...questBody.parse(data), parentId: null }
}

const WAITING_TEXT: Record<NonNullable<BoardQuest['blockReason']>, string> = {
  hall_not_found: 'Waiting: Hall not found',
  hall_locked: 'Waiting: Hall locked',
  private_provider_unavailable: 'Waiting: no private-eligible provider',
  budget_exhausted: 'Waiting: daily budget used up',
  no_provider_available: 'Waiting: no provider available',
}

/** Why a queued Quest is waiting, from the routing log's latest block; null unless routing is holding it. */
export function waitingReason(quest: BoardQuest): string | null {
  if (quest.state !== 'queued' || quest.lastError !== 'routing_blocked') {
    return null
  }
  return quest.blockReason === null
    ? 'Waiting: routing is blocked'
    : WAITING_TEXT[quest.blockReason]
}

/** Whether a Quest carries private text (its data class is private). */
export function isPrivateQuest(quest: BoardQuest): boolean {
  return quest.dataClass === 'private'
}
