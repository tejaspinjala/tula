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
})
const pageBody = z.object({ quests: z.array(questBody), next: z.string().nullable() })

/** A Quest as the Quest Board shows it. */
export type BoardQuest = z.infer<typeof questBody>
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
  const quests: BoardQuest[] = []
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
    quests.push(...body.quests)
    if (body.next === null) {
      return quests
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

/** The event-stream URL for a session; a browser socket cannot set headers, so the token rides the query. */
export function questStreamUrl(session: Session, origin: string, lastSeq: number): string {
  const url = new URL(`/api/guilds/${session.guildId}/events`, origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('last_seq', String(lastSeq))
  url.searchParams.set('access_token', session.token)
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
