import { expect, test } from 'bun:test'
import { describeEntry, formatCents, loadTreasury } from './treasury'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const overview = {
  mode: 'paper',
  balances: { operating: 7000, reserve: 3000, profit: 0 },
  spentTodayCents: 250,
  day: '2030-01-01',
  limits: {
    dailyCapCents: 1000,
    treasurerLimitCents: 500,
    reservePercent: 30,
    reinvestPercent: 40,
  },
}
const entry = (seq: number, kind: string, bucket: string, amountCents: number) => ({
  seq,
  id: `e${seq}`,
  kind,
  bucket,
  amountCents,
  mode: 'paper',
  spendId: null,
  idemKey: null,
  evidence: null,
  day: '2030-01-01',
  createdAt: '2030-01-01T00:00:00.000Z',
  prevHash: '0'.repeat(64),
  hash: `${seq}`.repeat(64).slice(0, 64),
})

test('integer cents read as dollars', () => {
  expect(formatCents(7000)).toBe('$70.00')
  expect(formatCents(1)).toBe('$0.01')
  expect(formatCents(-250)).toBe('-$2.50')
})

test('the Treasury view follows entry pages and reports the chain check, with the session token', async () => {
  const urls: string[] = []
  const base = `/api/guilds/${guild}/treasury`
  const pages: Record<string, unknown> = {
    [base]: overview,
    [`${base}/entries?limit=1`]: { items: [entry(1, 'seed', 'reserve', 3000)], next: 1 },
    [`${base}/entries?limit=1&after=1`]: {
      items: [entry(2, 'seed', 'operating', 7000)],
      next: null,
    },
    [`${base}/verify`]: { intact: true, entries: 2 },
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(`${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json(pages[url] ?? {}, { status: pages[url] ? 200 : 404 })
  }
  const loaded = await loadTreasury(session, fetcher, { limit: 1 })
  expect(loaded.overview.balances.operating).toBe(7000)
  expect(loaded.entries.map((e) => e.seq)).toEqual([1, 2])
  expect(loaded.chain).toEqual({ intact: true, entries: 2 })
  expect(urls.every((u) => u.endsWith('|Bearer t1'))).toBe(true)
})

test('a refused request throws', async () => {
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  await expect(loadTreasury(session, fetcher)).rejects.toThrow()
})

test('an entry reads as its kind, bucket and signed amount', () => {
  expect(describeEntry(entry(3, 'spend_reserve', 'operating', -500))).toBe(
    '#3 spend reserve: operating -$5.00'
  )
})
