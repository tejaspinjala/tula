import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const {
  AWAY_REOPEN_EVENT,
  AWAY_RETURNED_EVENT,
  announceReturn,
  digestLine,
  loadAwayDigest,
  markScrollSeen,
  requestAwayScroll,
  scrollSeen,
} = await import('./away-digest')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const other = { token: 't2', guildId: '22222222-2222-4222-8222-222222222222' }
const entry = {
  seq: 1,
  kind: 'quest_done',
  occurredAt: '2026-03-01T09:00:00.000Z',
  questId: 'q1',
  sessionId: null,
  sealId: null,
  reason: null,
  amountCents: null,
  status: null,
}

beforeAll(() => localStorage.clear())

test('loadAwayDigest reads a page with the session token and a cursor', async () => {
  const seen: Array<[string, string | null]> = []
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    seen.push([String(url), new Headers(init?.headers).get('authorization')])
    return Response.json({
      window: { since: '2026-03-01T08:00:00.000Z', until: null, open: true },
      entries: [entry],
      next: 9,
    })
  }
  const page = await loadAwayDigest(session, fetcher, { after: 4, limit: 20 })
  expect(seen).toEqual([
    [`/api/guilds/${session.guildId}/guild-master/away-digest?limit=20&after=4`, 'Bearer t1'],
  ])
  expect(page.entries[0]?.questId).toBe('q1')
  expect(page.next).toBe(9)
})

test('loadAwayDigest refuses a malformed body and surfaces a refusal', async () => {
  await expect(
    loadAwayDigest(session, async () => Response.json({ nope: 1 }))
  ).rejects.toBeDefined()
  await expect(
    loadAwayDigest(session, async () =>
      Response.json({ error: 'unauthenticated' }, { status: 401 })
    )
  ).rejects.toMatchObject({ code: 'unauthenticated' })
})

test('a window is remembered as seen per viewer, and a new window is not', () => {
  const since = '2026-03-01T08:00:00.000Z'
  expect(scrollSeen(session, since)).toBe(false)
  markScrollSeen(session, since)
  expect(scrollSeen(session, since)).toBe(true)
  expect(scrollSeen(session, '2026-03-02T08:00:00.000Z')).toBe(false)
  expect(scrollSeen(other, since)).toBe(false)
})

test('storage that throws never breaks the scroll', () => {
  const real = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked')
    },
  })
  try {
    expect(scrollSeen(session, 'x')).toBe(false)
    expect(() => markScrollSeen(session, 'x')).not.toThrow()
  } finally {
    if (real) {
      Object.defineProperty(window, 'localStorage', real)
    }
  }
})

test('return and reopen are told as window events', () => {
  const got: string[] = []
  window.addEventListener(AWAY_RETURNED_EVENT, () => got.push('returned'))
  window.addEventListener(AWAY_REOPEN_EVENT, () => got.push('reopen'))
  announceReturn()
  requestAwayScroll()
  expect(got).toEqual(['returned', 'reopen'])
})

test('digestLine says each kind in words, with the reason and the amount', () => {
  expect(digestLine({ ...entry, kind: 'council_approved' })).toContain('Council approved')
  expect(digestLine({ ...entry, kind: 'escalated', reason: 'blocked' })).toContain('blocked')
  expect(digestLine({ ...entry, kind: 'seal_waiting', sealId: 's1' })).toContain('waiting')
  expect(digestLine(entry)).toContain('done')
  expect(digestLine({ ...entry, kind: 'spend', amountCents: 250, status: 'approved' })).toContain(
    '$2.50'
  )
  expect(digestLine({ ...entry, kind: 'from_the_future' })).toBe('Something happened.')
})
