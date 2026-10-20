import { expect, test } from 'bun:test'
import { loadHistory } from './history'
import { prefersReducedMotion, scrollBehavior } from './motion'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const event = (seq: number) => ({
  seq,
  type: 'note.added',
  payload: {},
  occurredAt: '2026-03-01T08:00:00.000Z',
})

test('loadHistory follows the page cursors with the session token and returns every event', async () => {
  const urls: string[] = []
  const auth: Array<string | null> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(url)
    auth.push(new Headers(init?.headers).get('authorization'))
    return url.includes('after=2')
      ? Response.json({ events: [event(3)], next: null })
      : Response.json({ events: [event(1), event(2)], next: 2 })
  }
  const events = await loadHistory(session, fetcher, { limit: 2 })
  expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
  expect(urls[0]).toBe(`/api/guilds/${session.guildId}/events/history?limit=2`)
  expect(urls[1]).toBe(`/api/guilds/${session.guildId}/events/history?limit=2&after=2`)
  expect(auth).toEqual(['Bearer t1', 'Bearer t1'])
})

test('loadHistory rejects on a refused request', async () => {
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  await expect(loadHistory(session, fetcher)).rejects.toThrow()
})

test('prefersReducedMotion reads the media query, and a missing matchMedia means no preference', () => {
  const media = (matches: boolean) => (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && matches,
  })
  expect(prefersReducedMotion(media(true))).toBe(true)
  expect(prefersReducedMotion(media(false))).toBe(false)
  expect(prefersReducedMotion(undefined)).toBe(false)
})

test('scripted scrolling is instant under reduced motion and smooth otherwise', () => {
  expect(scrollBehavior(true)).toBe('auto')
  expect(scrollBehavior(false)).toBe('smooth')
})
