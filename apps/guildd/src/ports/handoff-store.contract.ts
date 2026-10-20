import { describe, expect, test } from 'bun:test'
import { type Handoff, type HandoffStore, handoff, hashHandoff } from './handoff-store'

/** A store under test; `newQuest` makes a Quest id the store may reference in the given guild. */
export interface HandoffStoreFixture {
  store: HandoffStore
  newGuild: () => Promise<string>
  newQuest: (guildId: string) => Promise<string>
  /** Event types appended for the guild so far, with their payloads. */
  events: (guildId: string) => Promise<Array<{ type: string; payload: unknown }>>
}

const HASH = 'a'.repeat(64)

function sample(overrides: Partial<Handoff> = {}): Handoff {
  return {
    goal: 'Draft the brief',
    doneCondition: 'A draft brief is filed',
    met: true,
    evidence: [{ kind: 'artifact', ref: HASH }],
    openItems: [],
    artifacts: [HASH],
    ...overrides,
  }
}

/** The HandoffStore contract, run against every adapter. */
export function handoffStoreContract(name: string, make: () => Promise<HandoffStoreFixture>) {
  describe(`HandoffStore contract: ${name}`, () => {
    test('a Handoff is stored once per attempt and read back', async () => {
      const { store, newGuild, newQuest } = await make()
      const g = await newGuild()
      const q = await newQuest(g)
      const first = await store.record(g, q, 1, 'heralds-member-2', sample())
      expect(first.created).toBe(true)
      expect(first.stored.hash).toBe(hashHandoff(sample()))
      expect(await store.get(g, q, 1)).toEqual(first.stored)
      expect(await store.get(g, q, 2)).toBeNull()
    })

    test('recording again returns the first Handoff and changes nothing, even same-tick', async () => {
      const { store, newGuild, newQuest, events } = await make()
      const g = await newGuild()
      const q = await newQuest(g)
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => store.record(g, q, 1, 'm', sample())),
        store.record(g, q, 1, 'm', sample({ goal: 'Something else' })),
      ])
      expect(results.filter((r) => r.created)).toHaveLength(1)
      expect(new Set(results.map((r) => r.stored.hash)).size).toBe(1)
      const recorded = (await events(g)).filter((e) => e.type === 'handoff.recorded')
      expect(recorded).toHaveLength(1)
    })

    test('the event carries ids and the hash only', async () => {
      const { store, newGuild, newQuest, events } = await make()
      const g = await newGuild()
      const q = await newQuest(g)
      await store.record(g, q, 1, 'm', sample())
      const [event] = (await events(g)).filter((e) => e.type === 'handoff.recorded')
      expect(event?.payload).toEqual({
        quest_id: q,
        attempt: 1,
        handoff_hash: hashHandoff(sample()),
      })
    })

    test('a Quest holds the artifacts attached to it, and only those', async () => {
      const { store, newGuild, newQuest, events } = await make()
      const g = await newGuild()
      const q = await newQuest(g)
      const other = await newQuest(g)
      await Promise.all([store.attach(g, q, HASH, 5), store.attach(g, q, HASH, 5)])
      expect(await store.holds(g, q, HASH)).toBe(true)
      expect(await store.holds(g, other, HASH)).toBe(false)
      expect((await events(g)).filter((e) => e.type === 'artifact.attached')).toEqual([
        { type: 'artifact.attached', payload: { quest_id: q, hash: HASH } },
      ])
    })

    test('a guild cannot see another guild’s Handoffs or artifacts', async () => {
      const { store, newGuild, newQuest } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const q = await newQuest(a)
      await store.record(a, q, 1, 'm', sample())
      await store.attach(a, q, HASH, 5)
      expect(await store.get(b, q, 1)).toBeNull()
      expect(await store.holds(b, q, HASH)).toBe(false)
    })
  })

  describe('Handoff schema', () => {
    test('a Handoff marked met without evidence is rejected with a pointed message', () => {
      const result = handoff.safeParse(sample({ evidence: [] }))
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['evidence'])
      expect(result.error?.issues[0]?.message).toContain('evidence')
    })

    test('an unmet Handoff may carry no evidence, and unknown keys are rejected', () => {
      expect(handoff.safeParse(sample({ met: false, evidence: [] })).success).toBe(true)
      expect(handoff.safeParse({ ...sample(), extra: 1 }).success).toBe(false)
    })
  })
}
