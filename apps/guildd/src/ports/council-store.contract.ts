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
  })
}
