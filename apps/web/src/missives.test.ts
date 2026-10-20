import { expect, test } from 'bun:test'
import { loadMissives, missivesOf } from './missives'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const row = (id: string, from: string, to: string, text = id) => ({
  id,
  seq: 1,
  hallId: 'heralds',
  questId: 'q',
  from,
  to,
  text,
  sentAt: '2026-01-01T00:00:00.000Z',
})

test('a page of Hall missives is read with the session and its cursor is kept', async () => {
  const calls: string[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push(`${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json({ missives: [row('a', 'ana', 'hall')], next: 7 })
  }
  const page = await loadMissives(session, fetcher, 'heralds', { limit: 20 })
  expect(calls).toEqual([`/api/guilds/${guild}/halls/heralds/missives?limit=20|Bearer t1`])
  expect(page.missives.map((m) => m.id)).toEqual(['a'])
  expect(page.next).toBe(7)
})

test('the next page asks after the cursor', async () => {
  const calls: string[] = []
  const fetcher = async (url: string) => {
    calls.push(url)
    return Response.json({ missives: [], next: null })
  }
  await loadMissives(session, fetcher, 'heralds', { limit: 5, after: 7 })
  expect(calls).toEqual([`/api/guilds/${guild}/halls/heralds/missives?limit=5&after=7`])
})

test('a refused request throws and an odd body is not trusted', async () => {
  await expect(
    loadMissives(
      session,
      async () => Response.json({ error: 'unauthenticated' }, { status: 401 }),
      'heralds',
      {
        limit: 5,
      }
    )
  ).rejects.toThrow()
  await expect(
    loadMissives(session, async () => Response.json({ id: 'q9' }), 'heralds', { limit: 5 })
  ).rejects.toThrow()
})

test('a Member’s own missives are those they sent, received, or the Hall was told, not the rest', () => {
  const all = [
    row('1', 'ana', 'bo'),
    row('2', 'bo', 'cy'),
    row('3', 'cy', 'ana'),
    row('4', 'cy', 'hall'),
  ]
  expect(missivesOf(all, 'ana').map((m) => m.id)).toEqual(['1', '3', '4'])
})
