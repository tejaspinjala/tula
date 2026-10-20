import { afterAll, expect, test } from 'bun:test'
import { createDb, type Db } from '../db/client'
import { meterQuest, postCostReaderContract } from '../ports/post-cost-reader.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgModelLedger } from './pg-model-ledger'
import { PgPostCostReader } from './pg-post-cost-reader'
import { PgQuestQueue } from './pg-quest-queue'
import { PgSealStore } from './pg-seal-store'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
const keys = new MemoryKeyProvider()
const stores = () => ({
  quests: new PgQuestQueue(db, keys, clock, () => 0.5),
  ledger: new PgModelLedger(db, keys),
  seals: new PgSealStore(db, keys, clock),
})
const newGuild = () => foundTestGuild(db, { name: 'Costs', goal: 'g' })

postCostReaderContract('postgres', async () => ({
  reader: new PgPostCostReader(db),
  ...stores(),
  newGuild,
}))

/** A Db that counts the statements the reader runs inside its transactions. */
function countingDb(counter: { statements: number; transactions: number }): Db {
  return {
    ...db,
    withGuild: (guildId, fn) => {
      counter.transactions += 1
      return db.withGuild(guildId, (tx) =>
        fn(
          new Proxy(tx, {
            apply: (target, thisArg, args) => {
              counter.statements += 1
              return Reflect.apply(target, thisArg, args)
            },
          })
        )
      )
    },
  }
}

test('cost per post over more than 100 Quests costs one statement whatever the page size', async () => {
  const f = stores()
  const g = await newGuild()
  const campaigns = ['spring', 'summer', 'autumn', 'winter']
  for (let i = 0; i < 120; i++) {
    await meterQuest(f, g, `q${i}`, campaigns[i % 4], 10, 'posted')
  }
  await meterQuest(f, g, 'denied', 'spring', 999, 'denied')
  await meterQuest(f, g, 'unasked', undefined, 999, null)
  const counter = { statements: 0, transactions: 0 }
  const reader = new PgPostCostReader(countingDb(counter))
  let after: string | undefined
  const seen: Array<string | null> = []
  let overall: Awaited<ReturnType<typeof reader.byCampaign>>['overall'] | undefined
  do {
    const page = await reader.byCampaign(g, { limit: 1, ...(after ? { after } : {}) })
    expect(page.campaigns).toHaveLength(1)
    seen.push(page.campaigns[0]?.campaignId ?? null)
    expect(page.campaigns[0]).toMatchObject({ posts: 30, costMicros: 300, costPerPostMicros: 10 })
    overall = page.overall
    after = page.next ?? undefined
  } while (after !== undefined)
  expect(seen).toEqual(['autumn', 'spring', 'summer', 'winter'])
  expect(overall).toEqual({ posts: 120, costMicros: 1200, costPerPostMicros: 10 })
  // One transaction and one statement per page: 4 pages, never one lookup per Quest.
  expect(counter).toEqual({ statements: 4, transactions: 4 })
})
