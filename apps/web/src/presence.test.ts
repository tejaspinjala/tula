import { expect, test } from 'bun:test'
import { eventText } from './event-text'
import { describeAway, goAway, loadPresence, returnHome } from './presence'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const base = `/api/guilds/${session.guildId}/guild-master`
const away = { away: true, since: '2026-03-01T08:00:00.000Z', until: '2026-03-02T08:00:00.000Z' }

test('presence is read with the session token', async () => {
  const seen: Array<{ url: string; auth: string | null }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return Response.json(away)
  }
  expect(await loadPresence(session, fetcher)).toEqual(away)
  expect(seen).toEqual([{ url: `${base}/presence`, auth: 'Bearer t1' }])
})

test('going away POSTs the optional return time; returning POSTs to return', async () => {
  const sent: Array<{ url: string; method?: string | undefined; body: unknown }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return Response.json(url.endsWith('/return') ? { away: false, since: null, until: null } : away)
  }
  expect(await goAway(session, fetcher, away.until)).toEqual(away)
  await goAway(session, fetcher, null)
  expect((await returnHome(session, fetcher)).away).toBe(false)
  expect(sent).toEqual([
    { url: `${base}/away`, method: 'POST', body: { until: away.until } },
    { url: `${base}/away`, method: 'POST', body: { until: null } },
    { url: `${base}/return`, method: 'POST', body: undefined },
  ])
})

test('a refused request rejects with the error code', async () => {
  await expect(
    goAway(session, async () => Response.json({ error: 'invalid_away' }, { status: 400 }), 'x')
  ).rejects.toMatchObject({ code: 'invalid_away' })
})

test('describeAway says who is away and until when, or that the Guild Master is present', () => {
  expect(describeAway({ away: false, since: null, until: null })).toBe('You are here.')
  expect(describeAway({ ...away, until: null })).toBe('You are away until you return.')
  expect(describeAway(away)).toContain('You are away until')
})

test('away mode events read in plain language', () => {
  const ev = (type: string) => ({ seq: 3, type, payload: {}, occurredAt: away.since })
  expect(eventText(ev('guildmaster.away'))).toBe('Guild Master went away')
  expect(eventText(ev('guildmaster.returned'))).toBe('Guild Master returned')
})
