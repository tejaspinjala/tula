import { afterAll, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { PgModelLedger } from './adapters/pg-model-ledger'
import { PgProposalStore } from './adapters/pg-proposal-store'
import { PgQuestQueue } from './adapters/pg-quest-queue'
import { PgSealStore } from './adapters/pg-seal-store'
import { PgTripwireStore } from './adapters/pg-tripwire-store'
import { createDb } from './db/client'
import { defaultConfig } from './guild-config'
import { watchHalls } from './hall-watch'
import { hashProposal } from './ports/seal-store'
import { ProposalEngine } from './proposals'
import { foundTestGuild } from './testing/found-guild'
import { testDbUrl } from './testing/test-db'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

test('on Postgres a pass reads only the last hour of denials and failed Verdicts, however many old ones exist', async () => {
  const clock = new MemoryClock(new Date('2030-01-08T12:00:00.000Z'))
  const keys = new MemoryKeyProvider()
  const quests = new PgQuestQueue(db, keys, clock, () => 0.5)
  const sealStore = new PgSealStore(db, keys, clock)
  const proposals = new ProposalEngine({ store: new PgProposalStore(db, keys, clock) })
  const tripwires = new PgTripwireStore(db, keys, clock)
  const ledger = new PgModelLedger(db, keys)
  const guild = await foundTestGuild(db, { name: 'Watch', goal: 'g' })
  const config = defaultConfig()

  const questOf = async (title: string) =>
    (
      await quests.post(guild, {
        jobKey: title,
        templateId: 'herald-brief',
        hallId: 'heralds',
        rank: 'journeyman',
        dataClass: 'internal',
        title,
        ownerId: 'heralds-member-2',
        doneCondition: 'A draft brief is filed',
        roundLimit: 2,
      })
    ).quest
  const deny = async (title: string) => {
    const q = await questOf(title)
    const seal = await sealStore.request(guild, {
      questId: q.id,
      requestedBy: 'heralds-member-2',
      kind: 'post',
      text: title,
      evidence: 'e',
    })
    await sealStore.decide(guild, seal.id, {
      verdict: 'denied',
      expectedHash: await hashProposal(title),
    })
  }
  for (let i = 0; i < 25; i++) {
    await deny(`old-${i}`)
  }
  clock.advance(3 * 60 * 60 * 1000)
  for (let i = 0; i < 3; i++) {
    await deny(`recent-${i}`)
  }

  let rowsRead = 0
  const deps = {
    config: { current: async () => ({ version: 1, config }) },
    tripwires,
    ledger,
    quests,
    proposals,
    clock,
    sealStore: {
      list: async (...args: Parameters<typeof sealStore.list>) => {
        const page = await sealStore.list(...args)
        rowsRead += page.seals.length
        return page
      },
    },
  }
  expect(await watchHalls(deps, guild)).toEqual([])
  expect(rowsRead).toBe(3)
}, 60_000)
