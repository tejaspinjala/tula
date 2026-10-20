import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb, type Db } from '../db/client'
import { rateLimiterContract } from '../ports/rate-limiter.contract'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { PgRateLimiter } from './pg-rate-limiter'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

rateLimiterContract('postgres', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  return { limiter: new PgRateLimiter(db, clock), clock }
})

const rule = { limit: 3, windowMs: 60_000 }
const T0 = new Date('2026-01-01T00:00:00.000Z')

/** A Db double that records which rate-limit calls the limiter makes. */
function recordingDb() {
  const calls: string[] = []
  const fake: Pick<Db, 'bumpRateLimit' | 'pruneRateLimits'> = {
    bumpRateLimit: async () => {
      calls.push('bump')
      return 1
    },
    pruneRateLimits: async () => {
      calls.push('prune')
    },
  }
  return { fake, calls }
}

test('a hit is one bump and does not prune, unless the random draw selects it', async () => {
  const quiet = recordingDb()
  await new PgRateLimiter(quiet.fake, new MemoryClock(T0), () => 0.5).hit('b', rule)
  expect(quiet.calls).toEqual(['bump'])
  const chosen = recordingDb()
  await new PgRateLimiter(chosen.fake, new MemoryClock(T0), () => 0).hit('b', rule)
  expect(chosen.calls).toEqual(['bump', 'prune'])
})

test('the pruner removes expired windows, and an expired window is not resurrected', async () => {
  const bucket = `prune:${crypto.randomUUID()}`
  const clock = new MemoryClock(new Date('2020-01-01T00:00:00.000Z'))
  const limiter = new PgRateLimiter(db, clock, () => 1)
  await limiter.hit(bucket, rule)
  await limiter.hit(bucket, rule)
  const count = async () =>
    Number((await owner`select count(*) as n from rate_limits where bucket = ${bucket}`)[0]?.n)
  expect(await count()).toBe(1)
  await db.pruneRateLimits(new Date('2020-01-01T00:01:00.000Z'))
  expect(await count()).toBe(0)
  clock.advance(rule.windowMs * 2)
  const fresh = await limiter.hit(bucket, rule)
  expect(fresh.allowed).toBe(true)
  const row = await owner`select hits from rate_limits where bucket = ${bucket}`
  expect(row.map((r) => Number(r.hits))).toEqual([1])
})
