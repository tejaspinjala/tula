import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import { type NewQuest, QuestError, type QuestQueue, type SpawnRequest } from './quest-queue'

/** A queue under test, with the controllable clock it reads. Jitter is fixed at 0.5 (a 750ms first retry). */
export interface QuestQueueFixture {
  queue: QuestQueue
  clock: MemoryClock
  newGuild: () => Promise<string>
  /** The Quest event types appended for the guild so far, in order. */
  events: (guildId: string) => Promise<string[]>
  /** Pauses (or resumes) a Hall through the TripwireStore the queue was built with. */
  setHallPaused: (guildId: string, hallId: string, paused: boolean) => Promise<void>
  /** Bars (or lifts) the guild, or every guild, through the GateStore the queue was built with. */
  setBarred: (guildId: string, scope: 'guild' | 'global', barred: boolean) => Promise<void>
}

const LEASE = { leaseMs: 60_000, maxActive: 10 }

let counter = 0
function quest(overrides: Partial<NewQuest> = {}): NewQuest {
  counter += 1
  return {
    jobKey: `job-${counter}-${crypto.randomUUID()}`,
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    title: 'Draft the brief',
    ownerId: 'heralds-member-2',
    doneCondition: 'A draft brief is filed',
    roundLimit: 2,
    ...overrides,
  }
}

/** The QuestQueue contract, run against every adapter. `make` returns a fresh queue. */
export function questQueueContract(name: string, make: () => Promise<QuestQueueFixture>) {
  describe(`QuestQueue contract: ${name}`, () => {
    test('a Quest is found by its job key in its own guild only, and finding never posts', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const input = quest()
      expect(await queue.findByJobKey(g, input.jobKey)).toBeNull()
      const { quest: posted } = await queue.post(g, input)
      expect((await queue.findByJobKey(g, input.jobKey))?.id).toBe(posted.id)
      expect(await queue.findByJobKey(other, input.jobKey)).toBeNull()
      expect((await queue.list(g, { limit: 10 })).quests).toHaveLength(1)
    })

    test('a list can be narrowed to one Campaign', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const inA = await queue.post(g, quest({ jobKey: 'a1', campaignId: 'camp-a' }))
      await queue.post(g, quest({ jobKey: 'b1', campaignId: 'camp-b' }))
      await queue.post(g, quest({ jobKey: 'n1' }))
      const page = await queue.list(g, { limit: 10, campaignId: 'camp-a' })
      expect(page.quests.map((x) => x.id)).toEqual([inA.quest.id])
    })

    test('a Campaign list never returns another guild`s Quest of the same Campaign id', async () => {
      const { queue, newGuild } = await make()
      const [a, b] = [await newGuild(), await newGuild()]
      const mine = await queue.post(a, quest({ jobKey: 'a1', campaignId: 'shared' }))
      await queue.post(b, quest({ jobKey: 'b1', campaignId: 'shared' }))
      const page = await queue.list(a, { limit: 10, campaignId: 'shared' })
      expect(page.quests.map((x) => x.id)).toEqual([mine.quest.id])
    })

    test('a paused Hall has no Quest claimed until it resumes; other Halls still are', async () => {
      const { queue, newGuild, setHallPaused } = await make()
      const g = await newGuild()
      const { quest: held } = await queue.post(g, quest({ hallId: 'heralds' }))
      const { quest: free } = await queue.post(g, quest({ hallId: 'scribes' }))
      await setHallPaused(g, 'heralds', true)
      expect((await queue.claim(g, LEASE))?.id).toBe(free.id)
      expect(await queue.claim(g, LEASE)).toBeNull()
      expect(await queue.claim(g, { ...LEASE, questId: held.id })).toBeNull()
      await setHallPaused(g, 'heralds', false)
      expect((await queue.claim(g, LEASE))?.id).toBe(held.id)
    })

    test('a barred guild has no Quest claimed; another guild still claims; lifting restores', async () => {
      const { queue, newGuild, setBarred } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const { quest: held } = await queue.post(a, quest())
      const { quest: free } = await queue.post(b, quest())
      await setBarred(a, 'guild', true)
      try {
        expect(await queue.claim(a, LEASE)).toBeNull()
        expect(await queue.claim(a, { ...LEASE, questId: held.id })).toBeNull()
        expect((await queue.claim(b, LEASE))?.id).toBe(free.id)
      } finally {
        await setBarred(a, 'guild', false)
      }
      expect((await queue.claim(a, LEASE))?.id).toBe(held.id)
    })

    test('a global bar stops claims in every guild until it is lifted', async () => {
      const { queue, newGuild, setBarred } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const { quest: q } = await queue.post(b, quest())
      await setBarred(a, 'global', true)
      try {
        expect(await queue.claim(b, LEASE)).toBeNull()
      } finally {
        await setBarred(a, 'global', false)
      }
      expect((await queue.claim(b, LEASE))?.id).toBe(q.id)
    })

    test("another guild's pause does not stop this guild's claims", async () => {
      const { queue, newGuild, setHallPaused } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await setHallPaused(a, 'heralds', true)
      const { quest: q } = await queue.post(b, quest({ hallId: 'heralds' }))
      expect((await queue.claim(b, LEASE))?.id).toBe(q.id)
    })

    test('a posted Quest is queued with its owner, done-condition and round limit', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const { quest: q, created } = await queue.post(g, quest({ roundLimit: 3 }))
      expect(created).toBe(true)
      expect(q).toMatchObject({
        state: 'queued',
        ownerId: 'heralds-member-2',
        doneCondition: 'A draft brief is filed',
        roundLimit: 3,
        round: 0,
        attempts: 0,
        blockedBy: [],
        leaseExpiresAt: null,
      })
      expect(await queue.get(g, q.id)).toEqual(q)
    })

    test('a repeated job key returns the original Quest, even same-tick', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const input = quest()
      const results = await Promise.all(Array.from({ length: 8 }, () => queue.post(g, input)))
      expect(results.filter((r) => r.created)).toHaveLength(1)
      expect(new Set(results.map((r) => r.quest.id)).size).toBe(1)
      const page = await queue.list(g, { limit: 100 })
      expect(page.quests.filter((x) => x.jobKey === input.jobKey)).toHaveLength(1)
    })

    test('the same job key in two guilds is two Quests', async () => {
      const { queue, newGuild } = await make()
      const [a, b] = [await newGuild(), await newGuild()]
      const input = quest()
      const qa = await queue.post(a, input)
      const qb = await queue.post(b, input)
      expect([qa.created, qb.created]).toEqual([true, true])
      expect(qa.quest.id).not.toBe(qb.quest.id)
      expect(await queue.get(a, qb.quest.id)).toBeNull()
    })

    test('claiming leases a Quest to exactly one claimer, even same-tick', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      await queue.post(g, quest())
      const claims = await Promise.all(Array.from({ length: 8 }, () => queue.claim(g, LEASE)))
      const won = claims.filter((c) => c !== null)
      expect(won).toHaveLength(1)
      expect(won[0]).toMatchObject({ state: 'active', attempts: 1 })
    })

    test('a second claim of a leased Quest is rejected', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest())
      await queue.claim(g, { ...LEASE, questId: q.id })
      await expect(queue.claim(g, { ...LEASE, questId: q.id })).rejects.toMatchObject({
        code: 'already_claimed',
      })
      await expect(
        queue.claim(g, { ...LEASE, questId: crypto.randomUUID() })
      ).rejects.toBeInstanceOf(QuestError)
    })

    test('an expired lease is reclaimed as a new attempt and the old holder is stale', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      await queue.post(g, quest())
      const first = await queue.claim(g, LEASE)
      expect(await queue.claim(g, LEASE)).toBeNull()
      clock.advance(60_001)
      const second = await queue.claim(g, LEASE)
      expect(second).toMatchObject({ id: first?.id, attempts: 2 })
      await expect(queue.complete(g, second?.id ?? '', 1)).rejects.toMatchObject({
        code: 'stale_lease',
      })
    })

    test('renewing extends the lease so the Quest is not reclaimed', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      await queue.post(g, quest())
      const q = await queue.claim(g, LEASE)
      clock.advance(50_000)
      await queue.renew(g, q?.id ?? '', 1, 60_000)
      clock.advance(50_000)
      expect(await queue.claim(g, LEASE)).toBeNull()
    })

    test('completing twice has one effect', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      await queue.post(g, quest())
      const q = await queue.claim(g, LEASE)
      const id = q?.id ?? ''
      const [one, two] = await Promise.all([queue.complete(g, id, 1), queue.complete(g, id, 1)])
      expect(one.state).toBe('done')
      expect(two).toEqual(one)
      expect(await queue.get(g, id)).toEqual(one)
    })

    test('submitting for a Seal holds the Quest and spends a round', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      await queue.post(g, quest({ roundLimit: 1 }))
      const q = await queue.claim(g, LEASE)
      const id = q?.id ?? ''
      const held = await queue.submitForSeal(g, id, 1)
      expect(held).toMatchObject({ state: 'awaiting_seal', round: 1, leaseExpiresAt: null })
      expect(await queue.submitForSeal(g, id, 1)).toEqual(held)
      expect(await queue.claim(g, LEASE)).toBeNull()
      expect((await queue.complete(g, id, 1)).state).toBe('done')
    })

    describe('settling a Quest held for a Seal', () => {
      async function held(queue: QuestQueue, g: string, over: Partial<NewQuest> = {}) {
        const { quest: posted } = await queue.post(g, quest(over))
        const claimed = await queue.claim(g, { ...LEASE, questId: posted.id })
        await queue.submitForSeal(g, posted.id, claimed?.attempts ?? 0)
        return posted.id
      }

      test('a posted Seal finishes the Quest, keyed by quest id, and repeating changes nothing', async () => {
        const { queue, events, newGuild } = await make()
        const g = await newGuild()
        const id = await held(queue, g)
        const done = await queue.settleSeal(g, id, 'posted')
        expect(done.state).toBe('done')
        expect(await queue.settleSeal(g, id, 'posted')).toEqual(done)
        expect((await events(g)).filter((e) => e === 'quest.done')).toHaveLength(1)
      })

      test('a Council-approved Seal finishes the Quest with the coded reason council_approved', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        const id = await held(queue, g)
        const done = await queue.settleSeal(g, id, 'posted', { reason: 'council_approved' })
        expect(done).toMatchObject({ state: 'done', lastError: 'council_approved' })
        expect(await queue.get(g, id)).toMatchObject({
          state: 'done',
          lastError: 'council_approved',
        })
        expect(await queue.settleSeal(g, id, 'posted', { reason: 'council_approved' })).toEqual(
          done
        )
      })

      test('a rejected Seal sends the Quest back for a revision round while rounds remain', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        const id = await held(queue, g, { roundLimit: 2 })
        const back = await queue.settleSeal(g, id, 'rejected')
        expect(back).toMatchObject({ state: 'queued', round: 1, attempts: 1 })
        expect(await queue.settleSeal(g, id, 'rejected')).toEqual(back)
        const again = await queue.claim(g, LEASE)
        expect(again).toMatchObject({ id, attempts: 2 })
        expect((await queue.submitForSeal(g, id, 2)).round).toBe(2)
      })

      test('settling for a round the Quest is no longer on is refused and changes nothing', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        const id = await held(queue, g, { roundLimit: 3 })
        await expect(queue.settleSeal(g, id, 'rejected', { round: 2 })).rejects.toMatchObject({
          code: 'invalid_state',
        })
        expect((await queue.get(g, id))?.state).toBe('awaiting_seal')
      })

      test('a terminal rejection dead-letters at once with its coded reason', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        const id = await held(queue, g, { roundLimit: 3 })
        const dead = await queue.settleSeal(g, id, 'rejected', {
          terminal: true,
          reason: 'requester_reserved',
        })
        expect(dead).toMatchObject({ state: 'dead', lastError: 'requester_reserved' })
      })

      test('a rejected Seal dead-letters the Quest once its rounds are spent, freeing its Campaign', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        const id = await held(queue, g, { roundLimit: 1, campaignId: 'c1' })
        const { quest: next } = await queue.post(g, quest({ campaignId: 'c1' }))
        expect(await queue.claim(g, LEASE)).toBeNull()
        const dead = await queue.settleSeal(g, id, 'rejected')
        expect(dead.state).toBe('dead')
        expect((await queue.deadLetters(g, { limit: 10 })).quests.map((q) => q.id)).toEqual([id])
        expect((await queue.claim(g, LEASE))?.id).toBe(next.id)
      })

      test('a Quest that is not awaiting a Seal cannot be settled', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        const { quest: q } = await queue.post(g, quest())
        await queue.claim(g, LEASE)
        await expect(queue.settleSeal(g, q.id, 'posted')).rejects.toMatchObject({
          code: 'invalid_state',
        })
        await expect(queue.settleSeal(g, crypto.randomUUID(), 'posted')).rejects.toMatchObject({
          code: 'not_found',
        })
      })
    })

    test('each transition appends one event, and idempotent repeats append none', async () => {
      const { queue, clock, events, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest({ roundLimit: 2, maxAttempts: 2 }))
      await queue.post(g, { ...quest(), jobKey: q.jobKey })
      await queue.claim(g, LEASE)
      await queue.renew(g, q.id, 1, 60_000)
      await queue.fail(g, q.id, 1, 'x')
      await queue.fail(g, q.id, 1, 'x')
      clock.advance(1000)
      await queue.claim(g, LEASE)
      await queue.submitForSeal(g, q.id, 2)
      await queue.submitForSeal(g, q.id, 2)
      await queue.complete(g, q.id, 2)
      await queue.complete(g, q.id, 2)
      expect(await events(g)).toEqual([
        'quest.posted',
        'quest.claimed',
        'quest.retry_scheduled',
        'quest.claimed',
        'quest.awaiting_seal',
        'quest.done',
      ])
      const d = (await queue.post(g, quest({ maxAttempts: 1 }))).quest
      await queue.claim(g, LEASE)
      await queue.fail(g, d.id, 1, 'x')
      expect((await events(g)).slice(-3)).toEqual(['quest.posted', 'quest.claimed', 'quest.dead'])
    })

    test('barring the gates spends no attempt of the retry budget: after four bar-and-lift cycles one failure still retries', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest())
      for (let i = 0; i < 4; i += 1) {
        const claimed = await queue.claim(g, LEASE)
        expect(claimed?.id).toBe(q.id)
        await queue.releaseAllLeases('sandbox_unavailable')
      }
      const last = await queue.claim(g, LEASE)
      expect(last?.id).toBe(q.id)
      const failed = await queue.fail(g, q.id, last?.attempts ?? 0, 'sandbox_unavailable')
      expect(failed.state).toBe('queued')
      expect((await queue.deadLetters(g, { limit: 10 })).quests).toEqual([])
    })

    test('giving a claim back spends no attempt of the retry budget: after four releases one failure still retries', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest())
      for (let i = 0; i < 4; i += 1) {
        const claimed = await queue.claim(g, LEASE)
        expect(claimed?.id).toBe(q.id)
        await queue.releaseClaim(g, q.id, claimed?.attempts ?? 0, clock.now())
      }
      const last = await queue.claim(g, LEASE)
      expect(last?.id).toBe(q.id)
      const failed = await queue.fail(g, q.id, last?.attempts ?? 0, 'sandbox_unavailable')
      expect(failed.state).toBe('queued')
      expect((await queue.deadLetters(g, { limit: 10 })).quests).toEqual([])
    })

    test('refunded claims are counted as refunds (a wait, a bar, a park); a failure is not', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest())
      const first = await queue.claim(g, LEASE)
      await queue.releaseClaim(g, q.id, first?.attempts ?? 0, clock.now())
      const second = await queue.claim(g, LEASE)
      expect(second).toMatchObject({ attempts: 2, refunds: 1 })
      await queue.releaseLeases(g, 'routing_blocked')
      expect(await queue.get(g, q.id)).toMatchObject({ attempts: 2, refunds: 2 })
      await queue.claim(g, LEASE)
      const failed = await queue.fail(g, q.id, 3, 'timeout')
      expect(failed).toMatchObject({ attempts: 3, refunds: 2 })
    })

    test('forgiving the repeats of a Hall refunds the attempts of its open Quests only', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      const a = await queue.post(g, quest({ hallId: 'health' }))
      const b = await queue.post(g, quest({ hallId: 'heralds' }))
      for (let i = 0; i < 2; i += 1) {
        clock.advance(10_000)
        await queue.claim(g, { ...LEASE, questId: a.quest.id })
        await queue.fail(g, a.quest.id, i + 1, 'timeout')
        clock.advance(10_000)
        await queue.claim(g, { ...LEASE, questId: b.quest.id })
        await queue.fail(g, b.quest.id, i + 1, 'timeout')
      }
      expect(await queue.forgiveRepeats(g, 'health')).toBe(1)
      expect(await queue.get(g, a.quest.id)).toMatchObject({ attempts: 2, refunds: 2 })
      expect(await queue.get(g, b.quest.id)).toMatchObject({ attempts: 2, refunds: 0 })
    })

    test('waking routing waits makes only the routing-blocked Quests of that guild deliverable now', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const waiting = await queue.post(g, quest())
      const failing = await queue.post(g, quest())
      const elsewhere = await queue.post(other, quest())
      const later = new Date(clock.now().getTime() + 3_600_000)
      for (const [guild, q] of [
        [g, waiting.quest],
        [other, elsewhere.quest],
      ] as const) {
        const claimed = await queue.claim(guild, { ...LEASE, questId: q.id })
        await queue.releaseClaim(guild, q.id, claimed?.attempts ?? 0, later)
      }
      const crashed = await queue.claim(g, { ...LEASE, questId: failing.quest.id })
      await queue.fail(g, failing.quest.id, crashed?.attempts ?? 0, 'timeout')
      const failedAt = (await queue.get(g, failing.quest.id))?.notBefore
      expect(await queue.wakeRoutingWaits(g)).toBe(1)
      expect((await queue.get(g, waiting.quest.id))?.notBefore).toBe(clock.now().toISOString())
      expect((await queue.get(g, failing.quest.id))?.notBefore).toBe(failedAt)
      expect((await queue.get(other, elsewhere.quest.id))?.notBefore).toBe(later.toISOString())
      expect(await queue.wakeRoutingWaits(g)).toBe(0)
    })

    test('a Quest whose lease lapses past its attempts is dead-lettered, not leased again', async () => {
      const { queue, clock, events, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest({ maxAttempts: 2 }))
      await queue.claim(g, LEASE)
      clock.advance(60_001)
      await queue.claim(g, LEASE)
      clock.advance(60_001)
      expect(await queue.claim(g, LEASE)).toBeNull()
      expect((await queue.deadLetters(g, { limit: 10 })).quests.map((d) => d.id)).toEqual([q.id])
      expect((await events(g)).at(-1)).toBe('quest.dead')
    })

    test('releasing leases returns active Quests to queued at once, attempts unchanged, and is idempotent', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      await queue.post(g, quest())
      await queue.post(other, quest())
      const held = await queue.claim(g, LEASE)
      const theirs = await queue.claim(other, LEASE)
      if (!held || !theirs) {
        throw new Error('expected leases')
      }
      expect(await queue.releaseLeases(g, 'sandbox_unavailable')).toBe(1)
      expect(await queue.get(g, held.id)).toMatchObject({
        state: 'queued',
        attempts: 1,
        leaseExpiresAt: null,
        lastError: 'sandbox_unavailable',
      })
      expect(await queue.releaseLeases(g, 'sandbox_unavailable')).toBe(0)
      expect((await queue.get(other, theirs.id))?.state).toBe('active')
      const again = await queue.claim(g, LEASE)
      expect(again).toMatchObject({ id: held.id, attempts: 2 })
    })

    test('releasing the leases of named Halls leaves other Halls active, and a Hall in skipHalls is not claimed until it is dropped', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const a = await queue.post(g, quest({ hallId: 'health' }))
      const b = await queue.post(g, quest({ hallId: 'heralds' }))
      await queue.post(g, quest({ hallId: 'health' }))
      await queue.claim(g, LEASE)
      await queue.claim(g, LEASE)
      expect(await queue.releaseLeases(g, 'routing_blocked', ['health'])).toBe(1)
      expect((await queue.get(g, a.quest.id))?.state).toBe('queued')
      // A pause is not a crash: the claim it cost is refunded.
      expect((await queue.get(g, a.quest.id))?.maxAttempts).toBe(a.quest.maxAttempts + 1)
      expect((await queue.get(g, b.quest.id))?.state).toBe('active')
      expect(await queue.claim(g, { ...LEASE, skipHalls: ['health'] })).toBeNull()
      expect((await queue.claim(g, LEASE))?.hallId).toBe('health')
    })

    test('a targeted claim of a Quest in a skipped Hall returns nothing', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest({ hallId: 'health' }))
      expect(await queue.claim(g, { ...LEASE, questId: q.id, skipHalls: ['health'] })).toBeNull()
      expect((await queue.claim(g, { ...LEASE, questId: q.id }))?.id).toBe(q.id)
    })

    test("releasing all leases returns every guild's active Quests to queued at once, and repeating changes nothing more", async () => {
      const { queue, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await queue.post(a, quest())
      await queue.post(b, quest())
      const heldA = await queue.claim(a, LEASE)
      const heldB = await queue.claim(b, LEASE)
      if (!heldA || !heldB) {
        throw new Error('expected leases')
      }
      expect(await queue.releaseAllLeases('sandbox_unavailable')).toBeGreaterThanOrEqual(2)
      for (const [g, held] of [
        [a, heldA],
        [b, heldB],
      ] as const) {
        expect(await queue.get(g, held.id)).toMatchObject({
          state: 'queued',
          attempts: 1,
          leaseExpiresAt: null,
          lastError: 'sandbox_unavailable',
        })
      }
      await queue.releaseAllLeases('sandbox_unavailable')
      expect(await queue.claim(a, LEASE)).toMatchObject({ id: heldA.id, attempts: 2 })
      expect((await queue.get(b, heldB.id))?.state).toBe('queued')
    })

    describe('routing outcomes for a claimed Quest', () => {
      test('releasing a claim queues the Quest again after notBefore, fenced by attempt, idempotently', async () => {
        const { queue, clock, events, newGuild } = await make()
        const g = await newGuild()
        await queue.post(g, quest())
        const claimed = await queue.claim(g, LEASE)
        if (!claimed) {
          throw new Error('expected a claim')
        }
        await expect(queue.releaseClaim(g, claimed.id, 99, clock.now())).rejects.toMatchObject({
          code: 'stale_lease',
        })
        const later = new Date(clock.now().getTime() + 30_000)
        const back = await queue.releaseClaim(g, claimed.id, claimed.attempts, later)
        expect(back).toMatchObject({
          state: 'queued',
          attempts: 1,
          leaseExpiresAt: null,
          lastError: 'routing_blocked',
          notBefore: later.toISOString(),
        })
        expect(await queue.releaseClaim(g, claimed.id, claimed.attempts, later)).toEqual(back)
        expect(await queue.claim(g, LEASE)).toBeNull()
        clock.advance(30_000)
        expect(await queue.claim(g, LEASE)).toMatchObject({ id: claimed.id, attempts: 2 })
        expect((await events(g)).filter((e) => e === 'quest.retry_scheduled')).toHaveLength(1)
      })

      test('killing a claim dead-letters it with the coded reason and takes its dependents along', async () => {
        const { queue, clock, newGuild } = await make()
        const g = await newGuild()
        const { quest: root } = await queue.post(g, quest())
        const { quest: child } = await queue.post(g, quest({ blockedBy: [root.id] }))
        const claimed = await queue.claim(g, LEASE)
        if (!claimed) {
          throw new Error('expected a claim')
        }
        await expect(queue.kill(g, root.id, 99, 'hall_locked')).rejects.toMatchObject({
          code: 'stale_lease',
        })
        const dead = await queue.kill(g, root.id, claimed.attempts, 'hall_locked')
        expect(dead).toMatchObject({ state: 'dead', lastError: 'hall_locked' })
        expect(await queue.kill(g, root.id, claimed.attempts, 'hall_locked')).toEqual(dead)
        expect(await queue.get(g, child.id)).toMatchObject({
          state: 'dead',
          lastError: 'blocker_dead',
        })
        clock.advance(1)
        expect((await queue.deadLetters(g, { limit: 10 })).quests).toHaveLength(2)
      })

      test('a Quest not claimed cannot be released or killed, and other guilds cannot reach it', async () => {
        const { queue, clock, newGuild } = await make()
        const g = await newGuild()
        const other = await newGuild()
        const { quest: q } = await queue.post(g, quest())
        await expect(queue.releaseClaim(g, q.id, 0, clock.now())).rejects.toMatchObject({
          code: 'invalid_state',
        })
        await expect(queue.kill(g, q.id, 0, 'hall_locked')).rejects.toMatchObject({
          code: 'invalid_state',
        })
        await expect(queue.kill(other, q.id, 0, 'hall_locked')).rejects.toMatchObject({
          code: 'not_found',
        })
      })
    })

    test('a blocker must exist in the same guild', async () => {
      const { queue, newGuild } = await make()
      const [a, b] = [await newGuild(), await newGuild()]
      const other = await queue.post(b, quest())
      await expect(
        queue.post(a, quest({ blockedBy: [crypto.randomUUID()] }))
      ).rejects.toMatchObject({ code: 'unknown_blocker' })
      await expect(queue.post(a, quest({ blockedBy: [other.quest.id] }))).rejects.toMatchObject({
        code: 'unknown_blocker',
      })
    })

    test('after a newer delivery submits, an older delivery cannot complete the Quest', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      const { quest: q } = await queue.post(g, quest())
      await queue.claim(g, LEASE)
      clock.advance(60_001)
      await queue.claim(g, LEASE)
      await queue.submitForSeal(g, q.id, 2)
      await expect(queue.complete(g, q.id, 1)).rejects.toMatchObject({ code: 'stale_lease' })
      expect((await queue.complete(g, q.id, 2)).state).toBe('done')
    })

    test('a failed Quest is retried after a jittered delay', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      await queue.post(g, quest())
      const q = await queue.claim(g, LEASE)
      const failed = await queue.fail(g, q?.id ?? '', 1, 'provider_error')
      expect(failed).toMatchObject({ state: 'queued', lastError: 'provider_error' })
      expect(await queue.claim(g, LEASE)).toBeNull()
      clock.advance(751)
      expect(await queue.claim(g, LEASE)).toMatchObject({ id: q?.id, attempts: 2 })
    })

    test('caller text never reaches the stored error: only a coded reason does', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      await queue.post(g, quest())
      const q = await queue.claim(g, LEASE)
      const secret = 'Bearer sk-live-4eC39HqLyjWDarjtT1zdp7dc'
      const failed = await queue.fail(g, q?.id ?? '', 1, secret)
      expect(failed.lastError).toBe('unknown')
      expect(JSON.stringify(await queue.list(g, { limit: 10 }))).not.toContain('sk-live')
    })

    test('a Quest that keeps failing lands in the dead-letter list', async () => {
      const { queue, clock, newGuild } = await make()
      const g = await newGuild()
      const { quest: posted } = await queue.post(g, quest({ maxAttempts: 2 }))
      for (const attempt of [1, 2]) {
        clock.advance(10_000)
        await queue.claim(g, LEASE)
        await queue.fail(g, posted.id, attempt, 'timeout')
      }
      const dead = await queue.deadLetters(g, { limit: 10 })
      expect(dead.quests.map((d) => [d.id, d.state, d.lastError])).toEqual([
        [posted.id, 'dead', 'timeout'],
      ])
      clock.advance(1_000_000)
      expect(await queue.claim(g, LEASE)).toBeNull()
      const again = await queue.fail(g, posted.id, 2, 'timeout')
      expect(again.state).toBe('dead')
    })

    test('a dead Quest dead-letters the Quests it blocks, transitively, with a coded reason', async () => {
      const { queue, clock, newGuild, events } = await make()
      const g = await newGuild()
      const { quest: root } = await queue.post(g, quest({ maxAttempts: 1 }))
      const { quest: child } = await queue.post(g, quest({ blockedBy: [root.id] }))
      const { quest: grandchild } = await queue.post(g, quest({ blockedBy: [child.id] }))
      const { quest: free } = await queue.post(g, quest())
      clock.advance(10_000)
      expect((await queue.claim(g, { ...LEASE, questId: root.id }))?.id).toBe(root.id)
      await queue.fail(g, root.id, 1, 'timeout')
      const dead = await queue.deadLetters(g, { limit: 10 })
      expect(dead.quests.map((d) => [d.id, d.lastError])).toEqual([
        [root.id, 'timeout'],
        [child.id, 'blocker_dead'],
        [grandchild.id, 'blocker_dead'],
      ])
      expect((await queue.get(g, free.id))?.state).toBe('queued')
      expect((await events(g)).filter((e) => e === 'quest.dead')).toHaveLength(3)
    })

    test('Quests of one Campaign are delivered one at a time, in posting order', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const first = await queue.post(g, quest({ campaignId: 'launch' }))
      const second = await queue.post(g, quest({ campaignId: 'launch' }))
      const other = await queue.post(g, quest({ campaignId: 'other' }))
      const a = await queue.claim(g, LEASE)
      const b = await queue.claim(g, LEASE)
      expect([a?.id, b?.id]).toEqual([first.quest.id, other.quest.id])
      expect(await queue.claim(g, LEASE)).toBeNull()
      await queue.complete(g, first.quest.id, 1)
      expect((await queue.claim(g, LEASE))?.id).toBe(second.quest.id)
    })

    test('a Quest waits for the Quests that block it', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const blocker = await queue.post(g, quest())
      await queue.post(g, quest({ blockedBy: [blocker.quest.id] }))
      const first = await queue.claim(g, LEASE)
      expect(first?.id).toBe(blocker.quest.id)
      expect(await queue.claim(g, LEASE)).toBeNull()
      await queue.complete(g, blocker.quest.id, 1)
      expect(await queue.claim(g, LEASE)).not.toBeNull()
    })

    test('the concurrency cap bounds live leases, even same-tick', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      for (let i = 0; i < 5; i++) {
        await queue.post(g, quest())
      }
      const claims = await Promise.all(
        Array.from({ length: 5 }, () => queue.claim(g, { leaseMs: 60_000, maxActive: 2 }))
      )
      expect(claims.filter((c) => c !== null)).toHaveLength(2)
    })

    describe('a parent waiting on its children', () => {
      const setup = async (mode: 'all' | 'any') => {
        const f = await make()
        const g = await f.newGuild()
        const { quest: parent } = await f.queue.post(g, quest())
        const held = await f.queue.claim(g, LEASE)
        if (held?.id !== parent.id) {
          throw new Error('expected the parent claim')
        }
        const { quest: c1 } = await f.queue.post(g, quest())
        const { quest: c2 } = await f.queue.post(g, quest())
        const parked = await f.queue.park(g, parent.id, held.attempts, [c1.id, c2.id], mode)
        return { ...f, g, parent, held, c1, c2, parked }
      }
      const run = async (f: { queue: QuestQueue; g: string }, id: string) => {
        const claimed = await f.queue.claim(f.g, { ...LEASE, questId: id })
        if (!claimed) {
          throw new Error('expected a claim')
        }
        return claimed
      }

      test('parking gives the slot back and is idempotent; the parent waits for every child (all)', async () => {
        const f = await setup('all')
        expect(f.parked).toMatchObject({
          state: 'queued',
          leaseExpiresAt: null,
          waitingOn: [f.c1.id, f.c2.id],
          waitMode: 'all',
        })
        expect(
          await f.queue.park(f.g, f.parent.id, f.held.attempts, [f.c1.id, f.c2.id], 'all')
        ).toEqual(f.parked)
        // Nothing the parent could claim: the children are the only deliverable Quests.
        const first = await run(f, f.c1.id)
        expect((await f.queue.claim(f.g, LEASE))?.id).toBe(f.c2.id)
        await f.queue.complete(f.g, first.id, first.attempts)
        expect(await f.queue.claim(f.g, LEASE)).toBeNull()
        await f.queue.complete(f.g, f.c2.id, 1)
        expect(await f.queue.claim(f.g, LEASE)).toMatchObject({
          id: f.parent.id,
          attempts: 2,
          waitingOn: [],
        })
      })

      test('a park and its resume do not spend the crash-retry budget, and attempts never pass maxAttempts', async () => {
        const { queue, clock, newGuild } = await make()
        const g = await newGuild()
        const { quest: parent } = await queue.post(g, quest({ maxAttempts: 2 }))
        const { quest: c1 } = await queue.post(g, quest())
        const { quest: c2 } = await queue.post(g, quest())
        const claim = async (id: string) => {
          const claimed = await queue.claim(g, { ...LEASE, questId: id })
          if (!claimed) {
            throw new Error('expected a claim')
          }
          return claimed
        }
        const first = await claim(parent.id)
        await queue.park(g, parent.id, first.attempts, [c1.id], 'all')
        await queue.complete(g, c1.id, (await claim(c1.id)).attempts)
        const second = await claim(parent.id)
        await queue.park(g, parent.id, second.attempts, [c2.id], 'all')
        await queue.complete(g, c2.id, (await claim(c2.id)).attempts)
        const third = await claim(parent.id)
        expect(third.attempts).toBe(3)
        // Two crashes are still allowed: the two waits did not use them up.
        expect(await queue.fail(g, parent.id, third.attempts, 'timeout')).toMatchObject({
          state: 'queued',
        })
        clock.advance(300_000)
        const fourth = await claim(parent.id)
        const dead = await queue.fail(g, parent.id, fourth.attempts, 'timeout')
        expect(dead.state).toBe('dead')
        expect(dead.attempts).toBeLessThanOrEqual(dead.maxAttempts)
      })

      test('with any, one finished child resumes the parent', async () => {
        const f = await setup('any')
        const first = await run(f, f.c1.id)
        await f.queue.complete(f.g, first.id, first.attempts)
        expect((await f.queue.claim(f.g, LEASE))?.id).toBe(f.parent.id)
      })

      test('a dead child counts as finished, so the parent resumes to see it; parking is fenced by attempt and needs a lease', async () => {
        const f = await setup('all')
        const first = await run(f, f.c1.id)
        await f.queue.kill(f.g, first.id, first.attempts, 'timeout')
        const second = await run(f, f.c2.id)
        await f.queue.kill(f.g, second.id, second.attempts, 'timeout')
        expect((await f.queue.claim(f.g, LEASE))?.id).toBe(f.parent.id)
        await expect(f.queue.park(f.g, f.parent.id, 1, [f.c1.id], 'all')).rejects.toMatchObject({
          code: 'stale_lease',
        })
        await expect(f.queue.park(f.g, f.c1.id, 1, [f.c2.id], 'all')).rejects.toMatchObject({
          code: 'invalid_state',
        })
        await expect(
          f.queue.park(f.g, f.parent.id, 2, [crypto.randomUUID()], 'all')
        ).rejects.toMatchObject({ code: 'unknown_blocker' })
      })
    })

    describe('sub-Quests', () => {
      const CAPS = { maxChildren: 3, maxDepth: 2 }
      const child = (over: Partial<SpawnRequest['child']> = {}): SpawnRequest['child'] => {
        const { jobKey: _jobKey, campaignId: _c, blockedBy: _b, ...rest } = quest(over)
        return rest
      }
      const hash = (n: number) => n.toString(16).padStart(64, '0')
      const setup = async () => {
        const f = await make()
        const g = await f.newGuild()
        await f.queue.post(g, quest())
        const parent = await f.queue.claim(g, LEASE)
        if (!parent) {
          throw new Error('expected a claim')
        }
        const spawn = (n: number, over: Partial<SpawnRequest> = {}) =>
          f.queue.spawn(g, {
            parentId: parent.id,
            attempt: parent.attempts,
            briefHash: hash(n),
            child: child(),
            ...CAPS,
            ...over,
          })
        return { ...f, g, parent, spawn }
      }
      const spawned = <T extends { ok: boolean }>(r: T) => {
        if (!r.ok) {
          throw new Error('expected the spawn to be accepted')
        }
        return r as Extract<T, { ok: true }>
      }

      test('spawns a linked child at depth 1, deliverable at once, with a quest.spawned event', async () => {
        const { queue, g, parent, spawn, events } = await setup()
        const made = spawned(await spawn(1, { child: child({ dataClass: 'private' }) }))
        expect(made.created).toBe(true)
        expect(made.quest).toMatchObject({ state: 'queued', campaignId: null, blockedBy: [] })
        expect(made.link).toMatchObject({
          parentId: parent.id,
          childId: made.quest.id,
          depth: 1,
          attempt: parent.attempts,
          briefHash: hash(1),
          dataClass: 'private',
        })
        expect(await queue.children(g, parent.id)).toEqual([made.link])
        expect(await queue.linkOf(g, made.quest.id)).toEqual(made.link)
        expect(await queue.linkOf(g, parent.id)).toBeNull()
        expect((await queue.claim(g, LEASE))?.id).toBe(made.quest.id)
        expect(await events(g)).toContain('quest.spawned')
      })

      test('a retry for the same parent, attempt and brief hash returns the same child, even over the cap', async () => {
        const { queue, g, parent, spawn, events } = await setup()
        const first = spawned(await spawn(1))
        const again = spawned(await spawn(1, { maxChildren: 1 }))
        expect(again).toMatchObject({ created: false, quest: { id: first.quest.id } })
        expect(await queue.children(g, parent.id)).toHaveLength(1)
        expect((await events(g)).filter((e) => e === 'quest.spawned')).toHaveLength(1)
        spawned(await spawn(2, { maxChildren: 2 }))
      })

      test('the children cap holds exactly at its boundary and writes nothing over it', async () => {
        const { queue, g, parent, spawn } = await setup()
        for (const n of [1, 2, 3]) {
          spawned(await spawn(n))
        }
        const before = (await queue.list(g, { limit: 100 })).quests.length
        expect(await spawn(4)).toEqual({ ok: false, error: 'spawn_cap' })
        expect((await queue.list(g, { limit: 100 })).quests).toHaveLength(before)
        expect(await queue.children(g, parent.id)).toHaveLength(3)
      })

      test('concurrent spawns never exceed the cap', async () => {
        const { queue, g, parent, spawn } = await setup()
        const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => spawn(n)))
        expect(results.filter((r) => r.ok)).toHaveLength(3)
        expect(await queue.children(g, parent.id)).toHaveLength(3)
      })

      test('depth is capped: a grandchild is allowed at maxDepth 2 and refused at 1', async () => {
        const { queue, g, spawn } = await setup()
        const kid = spawned(await spawn(1))
        const claimed = await queue.claim(g, { ...LEASE, questId: kid.quest.id })
        if (!claimed) {
          throw new Error('expected the child claim')
        }
        const grand = (n: number, maxDepth: number) =>
          queue.spawn(g, {
            parentId: claimed.id,
            attempt: claimed.attempts,
            briefHash: hash(n),
            child: child(),
            maxChildren: 3,
            maxDepth,
          })
        expect(await grand(10, 1)).toEqual({ ok: false, error: 'depth_cap' })
        expect(spawned(await grand(11, 2)).link.depth).toBe(2)
        expect(await grand(12, 2)).toMatchObject({ ok: true })
        const deepest = (await queue.children(g, claimed.id))[0]
        expect(deepest).toBeDefined()
        expect(
          deepest && (await queue.claim(g, { ...LEASE, questId: deepest.childId }))
        ).toBeTruthy()
      })

      test('only the holder of the live delivery may spawn', async () => {
        const { queue, g, parent, spawn } = await setup()
        await expect(spawn(1, { attempt: 99 })).rejects.toMatchObject({ code: 'stale_lease' })
        await queue.complete(g, parent.id, parent.attempts)
        await expect(spawn(1)).rejects.toMatchObject({ code: 'invalid_state' })
        await expect(spawn(1, { parentId: crypto.randomUUID() })).rejects.toMatchObject({
          code: 'not_found',
        })
      })

      test('linksFor returns the links of the given Quests only, and none from another guild', async () => {
        const { queue, newGuild, g, parent, spawn } = await setup()
        const a = spawned(await spawn(1))
        const b = spawned(await spawn(2))
        expect(await queue.linksFor(g, [a.quest.id, parent.id])).toEqual([a.link])
        expect(await queue.linksFor(g, [])).toEqual([])
        expect(await queue.linksFor(g, [a.quest.id, b.quest.id, 'not-a-uuid'])).toEqual([
          a.link,
          b.link,
        ])
        expect(await queue.linksFor(await newGuild(), [a.quest.id])).toEqual([])
      })

      test('sub-Quests are invisible to another guild', async () => {
        const { queue, newGuild, g, parent, spawn } = await setup()
        const made = spawned(await spawn(1))
        const other = await newGuild()
        expect(await queue.children(other, parent.id)).toEqual([])
        expect(await queue.linkOf(other, made.quest.id)).toBeNull()
        await expect(
          queue.spawn(other, {
            parentId: parent.id,
            attempt: parent.attempts,
            briefHash: hash(1),
            child: child(),
            ...CAPS,
          })
        ).rejects.toMatchObject({ code: 'not_found' })
        expect(await queue.children(g, parent.id)).toHaveLength(1)
      })
    })

    test('lists are paginated in posting order and filter by state', async () => {
      const { queue, newGuild } = await make()
      const g = await newGuild()
      const posted = []
      for (let i = 0; i < 5; i++) {
        posted.push((await queue.post(g, quest())).quest.id)
      }
      const p1 = await queue.list(g, { limit: 2 })
      const p2 = await queue.list(g, { limit: 2, ...(p1.next ? { after: p1.next } : {}) })
      const p3 = await queue.list(g, { limit: 2, ...(p2.next ? { after: p2.next } : {}) })
      expect([...p1.quests, ...p2.quests, ...p3.quests].map((x) => x.id)).toEqual(posted)
      expect(p3.next).toBeNull()
      await queue.claim(g, LEASE)
      expect((await queue.list(g, { limit: 10, state: 'active' })).quests).toHaveLength(1)
    })

    describe('Quest Board', () => {
      const setup = async (campaignId = 'team') => {
        const f = await make()
        const g = await f.newGuild()
        await f.queue.post(g, quest({ campaignId, ownerId: 'heralds-captain' }))
        const captain = await f.queue.claim(g, LEASE)
        if (!captain) {
          throw new Error('expected the Captain to claim')
        }
        const post = (n: number, over: { maxQuests?: number; attempt?: number } = {}) => {
          const { jobKey: _j, campaignId: _c, board: _b, ...rest } = quest()
          return f.queue.postBoard(g, {
            parentId: captain.id,
            attempt: over.attempt ?? captain.attempts,
            jobKey: `board-${captain.id}-${n}`,
            campaignId,
            quest: rest,
            maxQuests: over.maxQuests ?? 3,
          })
        }
        return { ...f, g, captain, post }
      }

      test('a board Quest joins the Campaign, is marked board, and runs beside the Captain and its peers', async () => {
        const { queue, g, captain, post } = await setup()
        const one = await post(1)
        const two = await post(2)
        if (!(one.ok && two.ok)) {
          throw new Error('expected both board posts')
        }
        expect(one).toMatchObject({ created: true, quest: { campaignId: 'team', board: true } })
        expect(captain.board).toBe(false)
        const claimed = [await queue.claim(g, LEASE), await queue.claim(g, LEASE)]
        expect(claimed.map((c) => c?.id)).toEqual([one.quest.id, two.quest.id])
      })

      test('the Campaign cap holds exactly at its boundary and writes nothing over it', async () => {
        const { queue, g, post } = await setup()
        for (const n of [1, 2, 3]) {
          expect((await post(n)).ok).toBe(true)
        }
        const before = (await queue.list(g, { limit: 100 })).quests.length
        expect(await post(4)).toEqual({ ok: false, error: 'campaign_cap' })
        expect((await queue.list(g, { limit: 100 })).quests).toHaveLength(before)
      })

      test('the cap is per Campaign, and a retried post returns the same Quest even over the cap', async () => {
        const { queue, g, post } = await setup()
        const first = await post(1, { maxQuests: 1 })
        expect(await post(1, { maxQuests: 1 })).toMatchObject({
          ok: true,
          created: false,
          quest: { id: first.ok ? first.quest.id : '' },
        })
        expect(await post(2, { maxQuests: 1 })).toEqual({ ok: false, error: 'campaign_cap' })
        const { quest: other } = await queue.post(g, quest({ campaignId: 'elsewhere' }))
        expect(other.board).toBe(false)
      })

      test('concurrent posts never exceed the Campaign cap', async () => {
        const { g, queue, post } = await setup()
        const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => post(n)))
        expect(results.filter((r) => r.ok)).toHaveLength(3)
        expect((await queue.list(g, { limit: 100 })).quests.filter((q) => q.board)).toHaveLength(3)
      })

      test('only the holder of the Captain Quest may post: a stale attempt is refused', async () => {
        const { post } = await setup()
        await expect(post(1, { attempt: 99 })).rejects.toMatchObject({ code: 'stale_lease' })
      })

      test('a Hall cap bounds live leases of that Hall under parallel claims; the excess waits queued', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        for (let i = 0; i < 6; i++) {
          await queue.post(g, quest({ hallId: 'heralds' }))
        }
        const { quest: elsewhere } = await queue.post(g, quest({ hallId: 'scribes' }))
        const opts = { ...LEASE, hallCaps: { heralds: 2 } }
        const claims = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(() => queue.claim(g, opts)))
        const got = claims.flatMap((c) => (c ? [c] : []))
        expect(got.filter((c) => c.hallId === 'heralds')).toHaveLength(2)
        expect(got.some((c) => c.id === elsewhere.id)).toBe(true)
        const queued = (await queue.list(g, { limit: 100, state: 'queued' })).quests
        expect(queued.filter((q) => q.hallId === 'heralds')).toHaveLength(4)
      })

      test('finishing a Quest frees its Hall slot for the next claim', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        for (let i = 0; i < 3; i++) {
          await queue.post(g, quest())
        }
        const opts = { ...LEASE, hallCaps: { heralds: 1 } }
        const first = await queue.claim(g, opts)
        expect(await queue.claim(g, opts)).toBeNull()
        if (!first) {
          throw new Error('expected a claim')
        }
        await queue.complete(g, first.id, first.attempts)
        expect(await queue.claim(g, opts)).not.toBeNull()
      })

      test('campaign events belong to team Campaigns: started with the first board Quest, finished with the last settle, once', async () => {
        const { queue, g, captain, post, events } = await setup('team-ev')
        expect(await events(g)).not.toContain('campaign.started')
        const one = await post(1)
        await post(2)
        expect((await events(g)).filter((e) => e === 'campaign.started')).toHaveLength(1)
        await queue.complete(g, captain.id, captain.attempts)
        expect(await events(g)).not.toContain('campaign.finished')
        const a = await queue.claim(g, LEASE)
        const b = await queue.claim(g, LEASE)
        if (!(a && b && one.ok)) {
          throw new Error('expected both board claims')
        }
        await Promise.all([
          queue.complete(g, a.id, a.attempts),
          queue.complete(g, b.id, b.attempts),
        ])
        expect((await events(g)).filter((e) => e === 'campaign.finished')).toHaveLength(1)
      })

      test('a Campaign with no board Quest (a rite run) never emits campaign events, even as its Quests settle one by one', async () => {
        const { queue, newGuild, events } = await make()
        const g = await newGuild()
        const { quest: a } = await queue.post(g, quest({ campaignId: 'wf' }))
        await queue.claim(g, LEASE)
        await queue.complete(g, a.id, 1)
        const { quest: b } = await queue.post(g, quest({ campaignId: 'wf' }))
        await queue.claim(g, LEASE)
        await queue.complete(g, b.id, 1)
        const all = await events(g)
        expect(all.filter((e) => e.startsWith('campaign.'))).toEqual([])
      })

      test('the Hall cap counts live-leased active Quests only: a Quest held for a Seal frees its slot', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        for (let i = 0; i < 2; i++) {
          await queue.post(g, quest())
        }
        const opts = { ...LEASE, hallCaps: { heralds: 1 } }
        const first = await queue.claim(g, opts)
        expect(await queue.claim(g, opts)).toBeNull()
        if (!first) {
          throw new Error('expected a claim')
        }
        await queue.submitForSeal(g, first.id, first.attempts)
        expect(await queue.claim(g, opts)).not.toBeNull()
      })

      test('the Captain`s plan Quest is outside the Hall cap: a cap of one still runs one Member beside it', async () => {
        const { queue, newGuild } = await make()
        const g = await newGuild()
        const { quest: plan } = await queue.post(
          g,
          quest({ templateId: 'team-plan', campaignId: 'team', ownerId: 'heralds-captain' })
        )
        await queue.post(g, quest())
        await queue.post(g, quest())
        const opts = { ...LEASE, hallCaps: { heralds: 1 } }
        expect((await queue.claim(g, opts))?.id).toBe(plan.id)
        expect(await queue.claim(g, opts)).not.toBeNull()
        expect(await queue.claim(g, opts)).toBeNull()
      })

      test('the Campaign cap counts board Quests only, not the Captain`s own or other Campaign Quests', async () => {
        const { queue, g, post } = await setup()
        await queue.post(g, quest({ campaignId: 'team' }))
        await queue.post(g, quest({ campaignId: 'team' }))
        expect((await post(1, { maxQuests: 1 })).ok).toBe(true)
        expect(await post(2, { maxQuests: 1 })).toEqual({ ok: false, error: 'campaign_cap' })
      })
    })

    test('one guild never sees or touches another guild`s Quests', async () => {
      const { queue, newGuild } = await make()
      const [a, b] = [await newGuild(), await newGuild()]
      const { quest: q } = await queue.post(a, quest())
      expect((await queue.list(b, { limit: 100 })).quests).toEqual([])
      expect(await queue.claim(b, LEASE)).toBeNull()
      await expect(queue.complete(b, q.id, 1)).rejects.toMatchObject({ code: 'not_found' })
    })
  })
}
