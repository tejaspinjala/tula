import { expect, test } from 'bun:test'
import {
  type BoardQuest,
  fetchStreamTicket,
  groupByState,
  loadQuests,
  questStreamUrl,
  readQuestFrame,
} from './quests'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const quest = (id: string, state: BoardQuest['state']): BoardQuest => ({
  id,
  title: `Quest ${id}`,
  hallId: 'heralds',
  ownerId: 'm',
  state,
  doneCondition: 'done',
  round: 0,
  roundLimit: 2,
  attempts: 0,
  lastError: null,
})

test('the quest list follows page cursors and sends the session token', async () => {
  const urls: string[] = []
  const pages: Record<string, unknown> = {
    [`/api/guilds/${guild}/quests?limit=2`]: { quests: [quest('a', 'queued')], next: '5' },
    [`/api/guilds/${guild}/quests?limit=2&after=5`]: {
      quests: [quest('b', 'done')],
      next: null,
    },
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(`${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json(pages[url] ?? {}, { status: pages[url] ? 200 : 404 })
  }
  const quests = await loadQuests(session, fetcher, { limit: 2 })
  expect(quests.map((q) => q.id)).toEqual(['a', 'b'])
  expect(urls[0]?.endsWith('|Bearer t1')).toBe(true)
})

test('dead letters come from their own list', async () => {
  const urls: string[] = []
  const fetcher = async (url: string) => {
    urls.push(url)
    return Response.json({ quests: [quest('x', 'dead')], next: null })
  }
  const dead = await loadQuests(session, fetcher, { deadLetters: true })
  expect(dead.map((q) => q.state)).toEqual(['dead'])
  expect(urls[0]).toBe(`/api/guilds/${guild}/quests/dead-letters?limit=50`)
})

test('a refused request throws', async () => {
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  await expect(loadQuests(session, fetcher)).rejects.toThrow()
})

test('the Quest Board groups Quests into a column per state', () => {
  const board = groupByState([quest('a', 'queued'), quest('b', 'done'), quest('c', 'queued')])
  expect(board.queued.map((q) => q.id)).toEqual(['a', 'c'])
  expect(board.done.map((q) => q.id)).toEqual(['b'])
  expect(board.awaiting_seal).toEqual([])
})

test('the stream url carries the cursor and the ticket, never the session token', () => {
  expect(questStreamUrl(session, 'http://localhost:5173', 7, 'tk')).toBe(
    `ws://localhost:5173/api/guilds/${guild}/events?last_seq=7&ticket=tk`
  )
  const secure = questStreamUrl(session, 'https://guild.example', 0, 'tk')
  expect(secure).toBe(`wss://guild.example/api/guilds/${guild}/events?last_seq=0&ticket=tk`)
  expect(secure).not.toContain('t1')
})

test('a stream ticket is fetched with the session token as a Bearer header', async () => {
  const seen: string[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method}|${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json({ ticket: 'abc', expiresAt: '2030-01-01T00:00:00.000Z' })
  }
  expect(await fetchStreamTicket(session, fetcher)).toBe('abc')
  expect(seen).toEqual([`POST|/api/guilds/${guild}/events/ticket|Bearer t1`])
  const refused = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  await expect(fetchStreamTicket(session, refused)).rejects.toThrow()
})

test('only quest events and snapshots ask the board to refresh; others just move the cursor', () => {
  const event = (type: string, seq: number) =>
    JSON.stringify({ type: 'event', event: { type, seq } })
  expect(readQuestFrame(event('quest.posted', 4))).toEqual({ refresh: true, seq: 4 })
  expect(readQuestFrame(event('note.added', 5))).toEqual({ refresh: false, seq: 5 })
  expect(readQuestFrame(JSON.stringify({ type: 'snapshot', head: 9 }))).toEqual({
    refresh: true,
    seq: null,
  })
  expect(readQuestFrame('not json')).toEqual({ refresh: false, seq: null })
})
