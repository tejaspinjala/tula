import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import type { AwaitingSealReader } from './awaiting-seal-reader'
import type { QuestQueue } from './quest-queue'
import type { SealStore } from './seal-store'

/** A reader under test with the stores it reads, the clock they share, and a way to get real guilds. */
export interface AwaitingSealReaderFixture {
  reader: AwaitingSealReader
  quests: QuestQueue
  seals: SealStore
  clock: MemoryClock
  newGuild: () => Promise<string>
}

/** A Quest held for a Seal (round 1). */
async function hold(f: AwaitingSealReaderFixture, guild: string, title: string) {
  const { quest } = await f.quests.post(guild, {
    jobKey: crypto.randomUUID(),
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title,
    ownerId: 'heralds-member-1',
    doneCondition: 'A draft is ready for a Seal',
    roundLimit: 3,
  })
  const claimed = await f.quests.claim(guild, { leaseMs: 60_000, maxActive: 50 })
  if (!claimed) {
    throw new Error('expected a claim')
  }
  return f.quests.submitForSeal(guild, claimed.id, claimed.attempts)
}

async function ask(f: AwaitingSealReaderFixture, guild: string, questId: string, round: number) {
  return f.seals.request(guild, {
    questId,
    requestedBy: 'heralds-member-1',
    kind: 'post',
    text: `Hello round ${round} of ${questId}`,
    evidence: 'verdict: pass',
    round,
  })
}

/** The AwaitingSealReader contract, run against every adapter. `make` returns fresh stores. */
export function awaitingSealReaderContract(
  name: string,
  make: () => Promise<AwaitingSealReaderFixture>
) {
  describe(`AwaitingSealReader contract: ${name}`, () => {
    test('lists only held Quests with nothing live to wait on, each with its latest Seal', async () => {
      const f = await make()
      const g = await f.newGuild()
      const noSeal = await hold(f, g, 'no seal')
      const waiting = await hold(f, g, 'waiting')
      await ask(f, g, waiting.id, waiting.round)
      const denied = await hold(f, g, 'denied')
      const deniedSeal = await ask(f, g, denied.id, denied.round)
      await f.seals.decide(g, deniedSeal.id, {
        verdict: 'denied',
        expectedHash: deniedSeal.actionHash,
      })
      const posted = await hold(f, g, 'posted')
      const postedSeal = await ask(f, g, posted.id, posted.round)
      await f.seals.decide(g, postedSeal.id, {
        verdict: 'approved',
        expectedHash: postedSeal.actionHash,
      })
      await f.seals.markPosted(g, postedSeal.id, postedSeal.text, { reauthenticated: true })
      await f.quests.post(g, {
        jobKey: crypto.randomUUID(),
        templateId: 'herald-announcement',
        hallId: 'heralds',
        rank: 'apprentice',
        dataClass: 'public',
        title: 'still queued',
        ownerId: 'heralds-member-1',
        doneCondition: 'x',
        roundLimit: 1,
      })
      const page = await f.reader.due(g, { limit: 10 })
      expect(page.next).toBeNull()
      expect(page.items.map((i) => [i.quest.id, i.seal?.id ?? null])).toEqual([
        [noSeal.id, null],
        [denied.id, deniedSeal.id],
        [posted.id, postedSeal.id],
      ])
    })

    test('a Seal of an earlier round does not hold back the Quest in a later round', async () => {
      const f = await make()
      const g = await f.newGuild()
      const first = await hold(f, g, 'revised')
      const seal = await ask(f, g, first.id, first.round)
      await f.seals.decide(g, seal.id, { verdict: 'denied', expectedHash: seal.actionHash })
      await f.quests.settleSeal(g, first.id, 'rejected')
      f.clock.advance(60 * 60 * 1000)
      const claimed = await f.quests.claim(g, { leaseMs: 60_000, maxActive: 5 })
      if (!claimed) {
        throw new Error('expected a claim')
      }
      const second = await f.quests.submitForSeal(g, claimed.id, claimed.attempts)
      expect(second.round).toBe(first.round + 1)
      const page = await f.reader.due(g, { limit: 10 })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]?.quest.round).toBe(second.round)
      expect(page.items[0]?.seal?.round).toBe(first.round)
    })

    test('a lapsed request reads as ended and is due', async () => {
      const f = await make()
      const g = await f.newGuild()
      const quest = await hold(f, g, 'lapses')
      const seal = await ask(f, g, quest.id, quest.round)
      expect((await f.reader.due(g, { limit: 10 })).items).toEqual([])
      f.clock.advance(73 * 60 * 60 * 1000)
      const page = await f.reader.due(g, { limit: 10 })
      expect(page.items.map((i) => [i.quest.id, i.seal?.id, i.seal?.status])).toEqual([
        [quest.id, seal.id, 'expired'],
      ])
    })

    test('pages in order with a cursor, and hasWork follows the same answer', async () => {
      const f = await make()
      const g = await f.newGuild()
      expect(await f.reader.hasWork(g)).toBe(false)
      const a = await hold(f, g, 'a')
      const b = await hold(f, g, 'b')
      const c = await hold(f, g, 'c')
      expect(await f.reader.hasWork(g)).toBe(true)
      const first = await f.reader.due(g, { limit: 2 })
      expect(first.items.map((i) => i.quest.id)).toEqual([a.id, b.id])
      expect(first.next).not.toBeNull()
      const second = await f.reader.due(g, {
        limit: 2,
        ...(first.next ? { after: first.next } : {}),
      })
      expect(second.items.map((i) => i.quest.id)).toEqual([c.id])
      expect(second.next).toBeNull()
    })

    test("another guild's held Quests are not listed", async () => {
      const f = await make()
      const g = await f.newGuild()
      const other = await f.newGuild()
      await hold(f, other, 'elsewhere')
      expect((await f.reader.due(g, { limit: 10 })).items).toEqual([])
      expect(await f.reader.hasWork(g)).toBe(false)
    })
  })
}
