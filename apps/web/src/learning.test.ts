import { expect, test } from 'bun:test'
import { decideSuggestion, loadSuggestions, scanLearning } from './learning'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const suggestion = (id: string) => ({
  id,
  sourceId: `pr:o/r#${id}`,
  repo: 'o/r',
  kind: 'pr',
  title: `o/r#${id}: change`,
  body: 'why',
  url: `https://github.com/o/r/pull/${id}`,
  status: 'pending',
  noteId: null,
  createdAt: '2030-01-01T00:00:00.000Z',
  decidedAt: null,
})

test('pending suggestions load page by page with the session token', async () => {
  const calls: Array<{ url: string; auth: string | null }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return url.includes('after=1')
      ? Response.json({ suggestions: [suggestion('2')], next: null })
      : Response.json({ suggestions: [suggestion('1')], next: '1' })
  }
  const loaded = await loadSuggestions(session, fetcher, { limit: 1 })
  expect(loaded.map((s) => s.id)).toEqual(['1', '2'])
  expect(calls.map((c) => c.url)).toEqual([
    `/api/guilds/${guild}/learning/suggestions?status=pending&limit=1`,
    `/api/guilds/${guild}/learning/suggestions?status=pending&limit=1&after=1`,
  ])
  expect(calls.every((c) => c.auth === 'Bearer t1')).toBe(true)
})

test('a server that never ends the pages is cut off', async () => {
  const fetcher = async () => Response.json({ suggestions: [suggestion('1')], next: '1' })
  await expect(loadSuggestions(session, fetcher)).rejects.toThrow('too many')
})

test('accept and dismiss post to the suggestion; a refusal throws with the code', async () => {
  const seen: string[] = []
  const ok = async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method} ${url}`)
    return Response.json({ suggestion: { ...suggestion('7'), status: 'accepted' } })
  }
  await decideSuggestion(session, ok, '7', 'accept')
  await decideSuggestion(session, ok, '7', 'dismiss')
  expect(seen).toEqual([
    `POST /api/guilds/${guild}/learning/suggestions/7/accept`,
    `POST /api/guilds/${guild}/learning/suggestions/7/dismiss`,
  ])
  const refused = async () => Response.json({ error: 'already_decided' }, { status: 409 })
  await expect(decideSuggestion(session, refused, '7', 'accept')).rejects.toMatchObject({
    status: 409,
    code: 'already_decided',
  })
})

test('a scan reports how many suggestions it added', async () => {
  const fetcher = async () => Response.json({ repos: 2, added: 5, failed: [] })
  expect(await scanLearning(session, fetcher)).toEqual({ repos: 2, added: 5, failed: 0 })
})
