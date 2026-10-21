import { expect, test } from 'bun:test'
import {
  type BoardQuest,
  campaignsOf,
  childrenOf,
  claimerOf,
  fetchStreamTicket,
  groupByState,
  inCampaign,
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
  campaignId: null,
  parentId: null,
  dataClass: 'internal',
  blockReason: null,
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

test('Sub-Quest links from the list set parentId, and childrenOf nests them under their parent', async () => {
  const fetcher = async () =>
    Response.json({
      quests: [quest('p', 'queued'), quest('c1', 'done'), quest('c2', 'active')],
      next: null,
      links: [
        { parentId: 'p', childId: 'c1', depth: 1 },
        { parentId: 'p', childId: 'c2', depth: 1 },
      ],
    })
  const quests = await loadQuests(session, fetcher)
  expect(quests.map((q) => q.parentId)).toEqual([null, 'p', 'p'])
  expect(childrenOf(quests, 'p').map((q) => q.id)).toEqual(['c1', 'c2'])
  expect(childrenOf(quests, 'c1')).toEqual([])
})

const inC = (
  id: string,
  campaignId: string | null,
  over: Partial<BoardQuest> = {}
): BoardQuest => ({
  ...quest(id, 'queued'),
  campaignId,
  ...over,
})

test('the Campaigns on the board are listed once each, sorted, without the Quests that have none', () => {
  expect(
    campaignsOf([inC('a', 'launch'), inC('b', null), inC('c', 'alpha'), inC('d', 'launch')])
  ).toEqual(['alpha', 'launch'])
})

test('filtering by Campaign keeps that Campaign`s Quests in board order; null keeps them all', () => {
  const all = [inC('a', 'launch'), inC('b', 'other'), inC('c', 'launch'), inC('d', null)]
  expect(inCampaign(all, 'launch').map((q) => q.id)).toEqual(['a', 'c'])
  expect(inCampaign(all, null).map((q) => q.id)).toEqual(['a', 'b', 'c', 'd'])
})

test('a Quest shows its claimer once it has been claimed, and none while it waits unclaimed', () => {
  expect(claimerOf(inC('a', 'x', { attempts: 0, ownerId: 'heralds-member-1' }))).toBeNull()
  expect(
    claimerOf(inC('b', 'x', { attempts: 1, state: 'active', ownerId: 'heralds-member-1' }))
  ).toBe('heralds-member-1')
  expect(
    claimerOf(inC('c', 'x', { attempts: 2, state: 'done', ownerId: 'heralds-member-2' }))
  ).toBe('heralds-member-2')
})

test('a queued Quest whose claim was released has no claimer', () => {
  expect(
    claimerOf(inC('d', 'x', { attempts: 1, state: 'queued', ownerId: 'health-member-1' }))
  ).toBeNull()
})

test('a queued Quest blocked by routing says why it waits, in plain words', async () => {
  const { waitingReason } = await import('./quests')
  const base = {
    id: 'q',
    title: 't',
    hallId: 'health',
    ownerId: 'm',
    state: 'queued' as const,
    doneCondition: 'd',
    round: 0,
    roundLimit: 2,
    attempts: 0,
    lastError: 'routing_blocked' as string | null,
    campaignId: null,
    parentId: null,
    dataClass: 'private' as const,
    blockReason: 'private_provider_unavailable' as const,
  }
  expect(waitingReason(base)).toBe('Waiting: no private-eligible provider')
  expect(waitingReason({ ...base, blockReason: 'hall_locked' })).toBe('Waiting: Hall locked')
  expect(waitingReason({ ...base, blockReason: null })).toBe('Waiting: routing is blocked')
  expect(waitingReason({ ...base, lastError: null })).toBeNull()
  expect(waitingReason({ ...base, state: 'active' })).toBeNull()
})
