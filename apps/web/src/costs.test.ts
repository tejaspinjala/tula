import { expect, test } from 'bun:test'
import { formatDollars, loadCostPerPost, loadCosts } from './costs'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const row = (key: string, costMicros: number) => ({
  key,
  calls: 2,
  inputTokens: 100,
  outputTokens: 50,
  costMicros,
})

test('the cost table follows page cursors for the chosen grouping', async () => {
  const urls: string[] = []
  const pages: Record<string, unknown> = {
    [`/api/guilds/${guild}/gateway/usage?by=quest&limit=2`]: {
      rows: [row('a', 1_500_000), row('b', 250_000)],
      next: 'b',
    },
    [`/api/guilds/${guild}/gateway/usage?by=quest&limit=2&after=b`]: {
      rows: [row('c', 0)],
      next: null,
    },
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(`${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json(pages[url] ?? {}, { status: pages[url] ? 200 : 404 })
  }
  const rows = await loadCosts(session, 'quest', fetcher, 2)
  expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c'])
  expect(urls[0]?.endsWith('|Bearer t1')).toBe(true)
})

test('cost per accepted post follows page cursors and keeps the overall figure', async () => {
  const urls: string[] = []
  const overall = { posts: 3, costMicros: 4600, costPerPostMicros: 1533 }
  const pages: Record<string, unknown> = {
    [`/api/guilds/${guild}/cost-per-post?limit=1`]: {
      overall,
      campaigns: [{ campaignId: null, posts: 1, costMicros: 600, costPerPostMicros: 600 }],
      next: 'x',
    },
    [`/api/guilds/${guild}/cost-per-post?limit=1&after=x`]: {
      overall,
      campaigns: [{ campaignId: 'spring', posts: 2, costMicros: 4000, costPerPostMicros: 2000 }],
      next: null,
    },
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(`${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json(pages[url] ?? {}, { status: pages[url] ? 200 : 404 })
  }
  const result = await loadCostPerPost(session, fetcher, 1)
  expect(result.overall).toEqual(overall)
  expect(result.campaigns.map((c) => c.campaignId)).toEqual([null, 'spring'])
  expect(urls[0]?.endsWith('|Bearer t1')).toBe(true)
})

test('a refused request throws', async () => {
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  await expect(loadCosts(session, 'day', fetcher)).rejects.toThrow()
})

test('dollars are shown from millionths without float drift', () => {
  expect(formatDollars(2_100_000)).toBe('$2.10')
  expect(formatDollars(0)).toBe('$0.00')
  expect(formatDollars(1)).toBe('$0.000001')
  expect(formatDollars(10_000_000)).toBe('$10.00')
})
