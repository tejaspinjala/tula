import { expect, test } from 'bun:test'
import { describePause, type HallPauseView, loadTripwires } from './tripwires'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const thresholds = { tokenBurnMultiple: 3, gateDenialsPerHour: 10, loopRepeats: 5 }
const pause = (id: string, hallId: string, tripwire: HallPauseView['tripwire']) => ({
  id,
  hallId,
  tripwire,
  observed: 12,
  threshold: 10,
  pausedAt: '2030-01-01T00:00:00.000Z',
})

test('the pause list follows page cursors and sends the session token', async () => {
  const urls: string[] = []
  const pages: Record<string, unknown> = {
    [`/api/guilds/${guild}/tripwires?limit=1`]: {
      thresholds,
      pauses: [pause('a', 'heralds', 'loop')],
      next: 3,
    },
    [`/api/guilds/${guild}/tripwires?limit=1&after=3`]: {
      thresholds,
      pauses: [pause('b', 'health', 'manual')],
      next: null,
    },
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(`${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json(pages[url] ?? {}, { status: pages[url] ? 200 : 404 })
  }
  const loaded = await loadTripwires(session, fetcher, { limit: 1 })
  expect(loaded.pauses.map((p) => p.hallId)).toEqual(['heralds', 'health'])
  expect(loaded.thresholds).toEqual(thresholds)
  expect(urls[0]?.endsWith('|Bearer t1')).toBe(true)
})

test('a refused request throws', async () => {
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  await expect(loadTripwires(session, fetcher)).rejects.toThrow()
})

test('each pause reads as a problem naming its Hall and Tripwire', () => {
  expect(describePause(pause('a', 'heralds', 'token_burn'))).toBe(
    'heralds paused: token burn (12 against 10)'
  )
  expect(describePause(pause('b', 'health', 'manual'))).toBe('health paused by the Guild Master')
})
