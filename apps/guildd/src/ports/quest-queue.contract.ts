import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import { type NewQuest, QuestError, type QuestQueue } from './quest-queue'

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

      test('parking gives the slot back, fenced by attempt and idempotent; the parent waits for every child (all)', async () => {
        const f = await setup('all')
        expect(f.parked).toMatchObject({
          state: 'queued',
          leaseExpiresAt: null,
          waitingOn: [f.c1.id, f.c2.id],
          waitMode: 'all',
        })
        await expect(
          f.queue.park(f.g, f.parent.id, 99, [f.c1.id], 'all')
        ).rejects.toMatchObject({ code: 'stale_lease' })
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

      test('with any, one finished child resumes the parent', async () => {
        const f = await setup('any')
        const first = await run(f, f.c1.id)
        await f.queue.complete(f.g, first.id, first.attempts)
        expect((await f.queue.claim(f.g, LEASE))?.id).toBe(f.parent.id)
      })

      test('a dead child counts as finished, so the parent resumes to see it; a parent must be leased to park', async () => {
        const f = await setup('all')
        const first = await run(f, f.c1.id)
        await f.queue.kill(f.g, first.id, first.attempts, 'timeout')
        const second = await run(f, f.c2.id)
        await f.queue.kill(f.g, second.id, second.attempts, 'timeout')
        expect((await f.queue.claim(f.g, LEASE))?.id).toBe(f.parent.id)
        await expect(
          f.queue.park(f.g, f.c1.id, 1, [f.c2.id], 'all')
        ).rejects.toMatchObject({ code: 'invalid_state' })
        await expect(
          f.queue.park(f.g, f.parent.id, 2, [crypto.randomUUID()], 'all')
        ).rejects.toMatchObject({ code: 'unknown_blocker' })
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
