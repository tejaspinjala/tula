import { describe, expect, test } from 'bun:test'
import type { CouncilStore, CouncilVoice, NewCouncilVote } from './council-store'

/** A store under test and a way to get guilds. */
export interface CouncilStoreFixture {
  store: CouncilStore
  newGuild: () => Promise<string>
}

const DAY = '2026-01-01'
const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)

function vote(voice: CouncilVoice, over: Partial<NewCouncilVote> = {}): NewCouncilVote {
  return {
    voice,
    vote: 'approve',
    reasons: ['fine'],
    abstainCode: null,
    inputTokens: 10,
    outputTokens: 5,
    costMicros: 15,
    ...over,
  }
}

function input(
  over: { questId?: string; proposalHash?: string; day?: string; sessionCap?: number } = {}
) {
  return { questId: 'q1', proposalHash: HASH, day: DAY, sessionCap: 5, ...over }
}

/** The CouncilStore contract, run against every adapter. `make` returns a fresh store. */
export function councilStoreContract(name: string, make: () => Promise<CouncilStoreFixture>) {
  describe(`CouncilStore contract: ${name}`, () => {
    test('opening a session creates it; opening again for the same hash returns the same one', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const first = await store.open(g, input())
      const second = await store.open(g, input())
      expect(first.status).toBe('created')
      expect(second.status).toBe('existing')
      if (first.status === 'cap_reached' || second.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      expect(second.session.id).toBe(first.session.id)
      expect(first.session).toMatchObject({ questId: 'q1', proposalHash: HASH, status: 'open' })
    })

    test('same-tick opens for one hash yield one session', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const results = await Promise.all([1, 2, 3].map(() => store.open(g, input())))
      expect(results.filter((r) => r.status === 'created')).toHaveLength(1)
      const ids = new Set(results.map((r) => (r.status === 'cap_reached' ? 'cap' : r.session.id)))
      expect(ids.size).toBe(1)
    })

    test('the daily session cap refuses a new hash but never an existing session', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.open(g, input({ sessionCap: 1 }))
      const other = await store.open(g, input({ proposalHash: OTHER_HASH, sessionCap: 1 }))
      expect(other.status).toBe('cap_reached')
      expect((await store.open(g, input({ sessionCap: 1 }))).status).toBe('existing')
      const nextDay = await store.open(
        g,
        input({ proposalHash: OTHER_HASH, day: '2026-01-02', sessionCap: 1 })
      )
      expect(nextDay.status).toBe('created')
    })

    test('a cap of zero opens nothing', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect((await store.open(g, input({ sessionCap: 0 }))).status).toBe('cap_reached')
    })

    test('votes are insert-only, one per voice: a second vote for a voice is refused and the first stays', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const opened = await store.open(g, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      const id = opened.session.id
      expect(await store.recordVote(g, id, vote('architect'))).toBe(true)
      expect(await store.recordVote(g, id, vote('architect', { vote: 'block' }))).toBe(false)
      const same = await Promise.all([
        store.recordVote(g, id, vote('skeptic')),
        store.recordVote(g, id, vote('skeptic')),
      ])
      expect(same.filter(Boolean)).toHaveLength(1)
      const votes = await store.votes(g, id)
      expect(votes.map((v) => [v.voice, v.vote])).toEqual([
        ['architect', 'approve'],
        ['skeptic', 'approve'],
      ])
      expect(votes[0]).toMatchObject({
        reasons: ['fine'],
        inputTokens: 10,
        outputTokens: 5,
        costMicros: 15,
      })
    })

    test('an abstention keeps why the system abstained', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const opened = await store.open(g, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      await store.recordVote(
        g,
        opened.session.id,
        vote('ops', {
          vote: 'abstain',
          reasons: [],
          abstainCode: 'invalid_output',
          costMicros: null,
        })
      )
      const [v] = await store.votes(g, opened.session.id)
      expect(v).toMatchObject({ vote: 'abstain', abstainCode: 'invalid_output', costMicros: null })
    })

    test('a session escalates once, with its reason', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const opened = await store.open(g, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      const id = opened.session.id
      expect(await store.escalate(g, id, 'block')).toBe(true)
      expect(await store.escalate(g, id, 'abstention')).toBe(false)
      const again = await store.open(g, input())
      if (again.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      expect(again.session).toMatchObject({ status: 'escalated', reason: 'block' })
    })

    test('a claim is taken once until it expires; its owner renews it and releases it', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const opened = await store.open(g, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      const id = opened.session.id
      const t0 = new Date('2026-01-01T00:00:00.000Z')
      const at = (ms: number) => new Date(t0.getTime() + ms)
      const claims = await Promise.all([
        store.claim(g, id, 'a', t0, 60_000),
        store.claim(g, id, 'b', t0, 60_000),
      ])
      expect(claims.filter(Boolean)).toHaveLength(1)
      const owner = claims[0] ? 'a' : 'b'
      const rival = owner === 'a' ? 'b' : 'a'
      expect(await store.claim(g, id, rival, at(59_999), 60_000)).toBe(false)
      expect(await store.claim(g, id, owner, at(59_999), 60_000)).toBe(true)
      expect(await store.claim(g, id, rival, at(100_000), 60_000)).toBe(false)
      expect(await store.claim(g, id, rival, at(119_998), 60_000)).toBe(false)
      expect(await store.claim(g, id, rival, at(119_999), 60_000)).toBe(true)
      await store.release(g, id, rival)
      expect(await store.claim(g, id, owner, t0, 60_000)).toBe(true)
    })

    test("a stale release never clears another owner's live claim", async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const opened = await store.open(g, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      const id = opened.session.id
      const t0 = new Date('2026-01-01T00:00:00.000Z')
      expect(await store.claim(g, id, 'a', t0, 60_000)).toBe(true)
      const later = new Date(t0.getTime() + 60_000)
      expect(await store.claim(g, id, 'b', later, 60_000)).toBe(true)
      await store.release(g, id, 'a')
      expect(await store.claim(g, id, 'c', later, 60_000)).toBe(false)
    })

    test('failed attempts are counted per session', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const opened = await store.open(g, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      expect(await store.recordFailure(g, opened.session.id)).toBe(1)
      expect(await store.recordFailure(g, opened.session.id)).toBe(2)
      expect(await store.recordFailure(await newGuild(), opened.session.id)).toBe(0)
    })

    test('escalating clears the claim, and another guild cannot claim or release', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const opened = await store.open(g, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      const id = opened.session.id
      const t0 = new Date('2026-01-01T00:00:00.000Z')
      expect(await store.claim(other, id, 'a', t0, 60_000)).toBe(false)
      expect(await store.claim(g, id, 'a', t0, 60_000)).toBe(true)
      await store.release(other, id, 'a')
      expect(await store.claim(g, id, 'b', t0, 60_000)).toBe(false)
      await store.escalate(g, id, 'block')
      expect(await store.claim(g, id, 'b', t0, 60_000)).toBe(false)
    })

    test("another guild cannot see or touch a guild's sessions or votes", async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const opened = await store.open(a, input())
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      await store.recordVote(a, opened.session.id, vote('architect'))
      expect(await store.votes(b, opened.session.id)).toEqual([])
      expect(await store.recordVote(b, opened.session.id, vote('skeptic'))).toBe(false)
      expect(await store.escalate(b, opened.session.id, 'block')).toBe(false)
      expect((await store.open(b, input({ sessionCap: 1 }))).status).toBe('created')
      expect(await store.votes(a, opened.session.id)).toHaveLength(1)
    })

    describe('approvals', () => {
      async function twoQuests() {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const opened = await store.open(g, input())
        if (opened.status === 'cap_reached') {
          throw new Error('unexpected cap')
        }
        return { store, g, id: opened.session.id }
      }

      test('approvals are counted per Quest, not per session: two Quests on one session consume one each', async () => {
        const { store, g, id } = await twoQuests()
        expect(await store.approve(g, id, { questId: 'q1', day: DAY, cap: 1 })).toBe('approved')
        expect(await store.approve(g, id, { questId: 'q2', day: DAY, cap: 1 })).toBe('cap_reached')
        expect(await store.approvalsToday(g, DAY, 'q9')).toBe(1)
      })

      test('a retry for the same Quest consumes nothing more, and its own approval is not counted against it', async () => {
        const { store, g, id } = await twoQuests()
        expect(await store.approve(g, id, { questId: 'q1', day: DAY, cap: 1 })).toBe('approved')
        expect(await store.approve(g, id, { questId: 'q1', day: DAY, cap: 1 })).toBe('approved')
        expect(await store.approvalsToday(g, DAY, 'q1')).toBe(0)
        expect(await store.approvalsToday(g, DAY, 'q2')).toBe(1)
      })

      test('a cap of zero never approves; the cap counts only its own day', async () => {
        const { store, g, id } = await twoQuests()
        expect(await store.approve(g, id, { questId: 'q1', day: DAY, cap: 0 })).toBe('cap_reached')
        expect(await store.approve(g, id, { questId: 'q1', day: DAY, cap: 1 })).toBe('approved')
        expect(await store.approve(g, id, { questId: 'q2', day: '2026-01-02', cap: 1 })).toBe(
          'approved'
        )
      })

      test('same-tick approvals never exceed the cap', async () => {
        const { store, g, id } = await twoQuests()
        const results = await Promise.all(
          ['q1', 'q2', 'q3', 'q4'].map((questId) =>
            store.approve(g, id, { questId, day: DAY, cap: 2 })
          )
        )
        expect(results.filter((r) => r === 'approved')).toHaveLength(2)
      })

      test('the first approval settles an open session as approved and ends its claim', async () => {
        const { store, g, id } = await twoQuests()
        expect(await store.claim(g, id, 'a', new Date('2026-01-01T00:00:00Z'), 60_000)).toBe(true)
        await store.approve(g, id, { questId: 'q1', day: DAY, cap: 5 })
        const again = await store.open(g, input())
        if (again.status === 'cap_reached') {
          throw new Error('unexpected cap')
        }
        expect(again.session.status).toBe('approved')
        expect(await store.claim(g, id, 'b', new Date('2026-01-01T00:00:00Z'), 60_000)).toBe(false)
        expect(await store.escalate(g, id, 'block')).toBe(false)
      })

      test("halt records once per (session, Quest) and approvalFor finds the Quest's own approval", async () => {
        const { store, g, id } = await twoQuests()
        expect(await store.halt(g, id, 'q1')).toBe(true)
        expect(await store.halt(g, id, 'q1')).toBe(false)
        expect(await store.halt(g, id, 'q2')).toBe(true)
        expect(await store.approvalFor(g, 'q1', HASH)).toBeNull()
        await store.approve(g, id, { questId: 'q1', day: DAY, cap: 5 })
        expect(await store.approvalFor(g, 'q1', HASH)).toBe(id)
        expect(await store.approvalFor(g, 'q2', HASH)).toBeNull()
        expect(await store.approvalFor(g, 'q1', OTHER_HASH)).toBeNull()
      })

      test('approvalsFor returns only the pairs holding an approval, in one read', async () => {
        const { store, g, id } = await twoQuests()
        await store.approve(g, id, { questId: 'q1', day: DAY, cap: 5 })
        const asked = [
          { questId: 'q1', proposalHash: HASH },
          { questId: 'q2', proposalHash: HASH },
          { questId: 'q1', proposalHash: OTHER_HASH },
        ]
        expect(await store.approvalsFor(g, asked)).toEqual([
          { questId: 'q1', proposalHash: HASH, sessionId: id },
        ])
        expect(await store.approvalsFor(g, [])).toEqual([])
        const other = await make()
        expect(await other.store.approvalsFor(await other.newGuild(), asked)).toEqual([])
      })

      test('an escalated session cannot be approved, and another guild cannot approve or halt', async () => {
        const { store, g, id } = await twoQuests()
        const other = await make()
        await store.escalate(g, id, 'block')
        expect(await store.approve(g, id, { questId: 'q1', day: DAY, cap: 5 })).toBe('not_found')
        const { store: s2, newGuild } = other
        const h = await newGuild()
        expect(await s2.approve(h, id, { questId: 'q1', day: DAY, cap: 5 })).toBe('not_found')
        expect(await s2.halt(h, id, 'q1')).toBe(false)
        expect(await s2.approvalFor(h, 'q1', HASH)).toBeNull()
        await store.halt(g, id, 'q1')
      })
    })

    test('list pages sessions newest first with a cursor, and only for the asking guild', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const hashes = ['1', '2', '3'].map((c) => c.repeat(64))
      const ids: string[] = []
      for (const proposalHash of hashes) {
        const opened = await store.open(g, input({ proposalHash }))
        if (opened.status === 'cap_reached') {
          throw new Error('unexpected cap')
        }
        ids.push(opened.session.id)
      }
      await store.open(other, input({ proposalHash: OTHER_HASH }))
      const first = await store.list(g, { limit: 2 })
      expect(first.sessions.map((s) => s.id)).toEqual(ids.slice(1).reverse())
      expect(first.next).toBe(ids.at(1) ?? null)
      const second = await store.list(g, { limit: 2, after: first.next ?? '' })
      expect(second.sessions.map((s) => s.id)).toEqual(ids.slice(0, 1))
      expect(second.next).toBeNull()
      expect((await store.list(other, { limit: 10 })).sessions).toHaveLength(1)
      expect((await store.list(other, { limit: 10, after: ids.at(1) ?? '' })).sessions).toEqual([])
    })
  })
}
