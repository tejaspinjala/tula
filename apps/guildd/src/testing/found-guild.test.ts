import { afterAll, expect, test } from 'bun:test'
import { verifyChain } from '../audit-chain'
import { eventsAfter } from '../events'
import { createHarness } from './harness'

const harness = await createHarness()
afterAll(() => harness.close())

test('a harness-founded guild has exactly its guild.founded event and an intact chain', async () => {
  const id = await harness.foundGuild({ name: 'Ember', goal: 'Ship' })
  const events = await harness.adapters.db.withGuild(id, (tx) => eventsAfter(tx, 0))
  expect(events.map((e) => e.type)).toEqual(['guild.founded'])
  const verdict = await harness.adapters.db.withGuild(id, (tx) =>
    verifyChain(tx, harness.adapters.keys, harness.adapters.witness)
  )
  expect(verdict).toMatchObject({ intact: true, entries: 1 })
})

test('the production Db surface has no unchained foundGuild', () => {
  expect('foundGuild' in harness.adapters.db).toBe(false)
})
