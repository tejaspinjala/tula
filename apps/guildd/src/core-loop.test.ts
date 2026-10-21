import { describe, expect, spyOn, test } from 'bun:test'
import { MemoryAwaitingSealReader } from './adapters/memory-awaiting-seal-reader'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryCouncilStore } from './adapters/memory-council-store'
import { MemoryIdentityStore } from './adapters/memory-identity-provider'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryPresenceStore } from './adapters/memory-presence-store'
import { MemoryProposalStore } from './adapters/memory-proposal-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySealStore } from './adapters/memory-seal-store'
import { WebAuthnIdentityProvider } from './adapters/webauthn-identity-provider'
import { reconcileSeals, requestPendingSeals, requestQuestSeal } from './core-loop'
import { CouncilEngine } from './council'
import { defaultConfig } from './guild-config'
import { GatewayError } from './model-gateway'
import type { Quest } from './ports/quest-queue'
import { SEAL_TTL_MS } from './ports/seal-store'
import { ProposalEngine } from './proposals'
import { SealEngine } from './seals'
import { ScriptedCouncilModel, voteReply } from './testing/scripted-council-model'
import type { ContentPolicy } from './verdict'

async function setup(roundLimit = 2) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const seals = new MemorySealStore(clock)
  const guild = crypto.randomUUID()
  const { quest } = await quests.post(guild, {
    jobKey: 'k',
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title: 'Announce',
    ownerId: 'heralds-member-1',
    doneCondition: 'An announcement draft is ready for a Seal',
    roundLimit,
  })
  const claimed = await quests.claim(guild, { leaseMs: 60_000, maxActive: 5 })
  const held = await quests.submitForSeal(guild, quest.id, claimed?.attempts ?? 0)
  const ask = (round: number) =>
    seals.request(guild, {
      questId: quest.id,
      requestedBy: 'heralds-member-1',
      kind: 'post',
      text: 'Hello',
      evidence: 'verdict: pass',
      round,
    })
  const deps = { quests, seals, awaiting: new MemoryAwaitingSealReader(quests, seals) }
  return { clock, quests, seals, guild, quest: held, ask, deps }
}

describe('reconcileSeals', () => {
  test('a consumed Seal finishes its Quest', async () => {
    const s = await setup()
    const seal = await s.ask(1)
    await s.seals.decide(s.guild, seal.id, { verdict: 'approved', expectedHash: seal.actionHash })
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(0)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('awaiting_seal')
    await s.seals.markPosted(s.guild, seal.id, 'Hello', { reauthenticated: true })
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(1)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('done')
  })

  test('a denied Seal queues a revision round; an expired one on the last round dead-letters', async () => {
    const s = await setup(2)
    const first = await s.ask(1)
    await s.seals.decide(s.guild, first.id, { verdict: 'denied', expectedHash: first.actionHash })
    await reconcileSeals(s.deps, s.guild)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('queued')
    const again = await s.quests.claim(s.guild, { leaseMs: 60_000, maxActive: 5 })
    await s.quests.submitForSeal(s.guild, s.quest.id, again?.attempts ?? 0)
    await s.ask(2)
    s.clock.advance(SEAL_TTL_MS + 1)
    await reconcileSeals(s.deps, s.guild)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('dead')
  })

  test('an approved Seal never posted expires after the post window and frees the Quest', async () => {
    const s = await setup(2)
    const seal = await s.ask(1)
    await s.seals.decide(s.guild, seal.id, { verdict: 'approved', expectedHash: seal.actionHash })
    s.clock.advance(72 * 3_600_000 - 1)
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(0)
    s.clock.advance(2)
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(1)
    expect((await s.seals.get(s.guild, seal.id))?.status).toBe('expired')
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('queued')
  })

  test('a Seal still waiting leaves the Quest held', async () => {
    const s = await setup()
    await s.ask(1)
    expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(0)
    expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('awaiting_seal')
  })
})

describe('requestQuestSeal', () => {
  async function gate(roundLimit = 2, policy?: ContentPolicy) {
    const s = await setup(roundLimit)
    const config = new MemoryConfigStore(s.clock)
    await config.seed(s.guild)
    const identityStore = new MemoryIdentityStore()
    identityStore.found(s.guild)
    const identity = new WebAuthnIdentityProvider(identityStore, {
      clock: s.clock,
      keys: new MemoryKeyProvider(),
      rpId: 'localhost',
      rpName: 'Guildhall',
      origin: 'http://localhost:5173',
    })
    const proposals = new ProposalEngine({
      store: new MemoryProposalStore(s.clock),
      ...(policy ? { policy } : {}),
    })
    const deps = {
      quests: s.quests,
      sealStore: s.seals,
      awaiting: new MemoryAwaitingSealReader(s.quests, s.seals),
      proposals,
      seals: new SealEngine({ store: s.seals, config, identity }),
    }
    const draft = (content: string) =>
      proposals.propose(s.guild, {
        questId: s.quest.id,
        author: 'heralds-member-1',
        kind: 'post',
        content,
      })
    return { ...s, deps, draft }
  }

  test('with no Council wired, every Seal Policy still requests a Seal and reads the policy', async () => {
    for (const sealPolicy of ['always', 'routine_alone'] as const) {
      const g = await gate()
      await g.draft('Hello guild')
      const reads: string[] = []
      const config = {
        current: async (guildId: string) => {
          reads.push(guildId)
          return { version: 1, config: { ...defaultConfig(), sealPolicy } }
        },
      }
      const result = await requestQuestSeal({ ...g.deps, config }, g.guild, g.quest)
      expect(result.outcome).toBe('requested')
      expect(reads).toEqual([g.guild])
    }
  })

  describe('the Council of Elders', () => {
    async function council(
      over: { sealPolicy?: 'always' | 'routine_alone'; sessionCap?: number } = {}
    ) {
      const g = await gate()
      const proposal = await g.draft('Hello guild')
      const model = new ScriptedCouncilModel((call) =>
        voteReply(call.system.includes('skeptic') ? 'block' : 'approve', `${call.questId} reason`)
      )
      const store = new MemoryCouncilStore()
      const presence = new MemoryPresenceStore(g.clock)
      const config = {
        current: async () => ({
          version: 1,
          config: {
            ...defaultConfig(),
            sealPolicy: over.sealPolicy ?? ('routine_alone' as const),
            caps: {
              ...defaultConfig().caps,
              ...(over.sessionCap === undefined
                ? {}
                : { maxCouncilSessionsPerDay: over.sessionCap }),
            },
          },
        }),
      }
      const deps = {
        ...g.deps,
        config,
        presence,
        clock: g.clock,
        council: new CouncilEngine({ store, model, clock: g.clock }),
      }
      return { ...g, deps, model, store, presence, proposal }
    }

    test('a routine Proposal while away convenes one session with five votes and the Seal carries them as evidence', async () => {
      const c = await council()
      await c.presence.goAway(c.guild, null)
      const result = await requestQuestSeal(c.deps, c.guild, c.quest)
      expect(result.outcome).toBe('requested')
      expect(c.model.calls).toHaveLength(5)
      const seal = await c.seals.forQuest(c.guild, c.quest.id)
      expect(seal?.status).toBe('requested')
      expect(seal?.evidence).toContain('Verdict passed')
      expect(seal?.evidence).toContain('Council of Elders')
      for (const voice of ['architect', 'skeptic', 'security', 'ops', 'user']) {
        expect(seal?.evidence).toContain(voice)
      }
      expect(seal?.evidence).toContain('skeptic block')
      expect(seal?.evidence).toContain(`${c.quest.id} reason`)
      expect(seal?.actionHash).toBe(c.proposal.hash)
    })

    test('a session another worker is running means not yet: no Seal is requested', async () => {
      const c = await council()
      await c.presence.goAway(c.guild, null)
      const opened = await c.store.open(c.guild, {
        questId: c.quest.id,
        proposalHash: c.proposal.hash,
        day: c.clock.now().toISOString().slice(0, 10),
        sessionCap: 20,
      })
      if (opened.status === 'cap_reached') {
        throw new Error('unexpected cap')
      }
      await c.store.claim(c.guild, opened.session.id, 'other-worker', c.clock.now(), 300_000)
      const result = await requestQuestSeal(c.deps, c.guild, c.quest)
      expect(result.outcome).toBe('council_pending')
      expect(c.model.calls).toHaveLength(0)
      expect(await c.seals.forQuest(c.guild, c.quest.id)).toBeNull()
    })

    test('a permanent config error three times requests the Seal with council_unavailable; the code is logged', async () => {
      const c = await council()
      await c.presence.goAway(c.guild, null)
      const failing = new CouncilEngine({
        store: c.store,
        model: new ScriptedCouncilModel(() => {
          throw new GatewayError('unknown_profile')
        }),
        clock: c.clock,
      })
      const deps = { ...c.deps, council: failing }
      const lines: string[] = []
      const spy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        lines.push(String(chunk))
        return true
      })
      try {
        await requestPendingSeals(deps, c.guild)
        await requestPendingSeals(deps, c.guild)
      } finally {
        spy.mockRestore()
      }
      expect(await c.seals.forQuest(c.guild, c.quest.id)).toBeNull()
      expect(
        lines.some((l) => l.includes('seal request failed') && l.includes('unknown_profile'))
      ).toBe(true)
      expect(lines.join('')).not.toContain(c.proposal.content)
      const third = await requestQuestSeal(deps, c.guild, c.quest)
      expect(third.outcome).toBe('requested')
      const seal = await c.seals.forQuest(c.guild, c.quest.id)
      expect(seal?.evidence).toContain('Verdict passed')
      expect(seal?.evidence).toContain('council_unavailable')
    })

    test('Bar the Gates mid-session never turns into a Seal request', async () => {
      const c = await council()
      await c.presence.goAway(c.guild, null)
      const barred = new CouncilEngine({
        store: c.store,
        model: new ScriptedCouncilModel(() => {
          throw new GatewayError('gates_barred')
        }),
        clock: c.clock,
      })
      for (let i = 0; i < 5; i += 1) {
        await expect(
          requestQuestSeal({ ...c.deps, council: barred }, c.guild, c.quest)
        ).rejects.toThrow()
      }
      expect(await c.seals.forQuest(c.guild, c.quest.id)).toBeNull()
    })

    test('asking again convenes no second session and runs no voice twice', async () => {
      const c = await council()
      await c.presence.goAway(c.guild, null)
      await requestQuestSeal(c.deps, c.guild, c.quest)
      await requestQuestSeal(c.deps, c.guild, c.quest)
      expect(c.model.calls).toHaveLength(5)
    })

    test.each([
      [
        'the Guild Master is present',
        async (c: Awaited<ReturnType<typeof council>>) => c.presence.returnHome(c.guild),
      ],
      [
        'the return time has passed',
        async (c: Awaited<ReturnType<typeof council>>) => {
          await c.presence.goAway(c.guild, new Date(c.clock.now().getTime() + 1000).toISOString())
          c.clock.advance(2000)
        },
      ],
    ])('no session when %s: the Seal is requested as today', async (_name, arrange) => {
      const c = await council()
      await arrange(c)
      const result = await requestQuestSeal(c.deps, c.guild, c.quest)
      expect(result.outcome).toBe('requested')
      expect(c.model.calls).toHaveLength(0)
      expect((await c.seals.forQuest(c.guild, c.quest.id))?.evidence).not.toContain('Council')
    })

    test('no session under always, for a private-class Quest, a non-eligible template, or a reached sessions cap', async () => {
      const cases: Array<[Awaited<ReturnType<typeof council>>, Quest]> = []
      const always = await council({ sealPolicy: 'always' })
      cases.push([always, always.quest])
      const priv = await council()
      cases.push([priv, { ...priv.quest, dataClass: 'private' }])
      const ineligible = await council()
      cases.push([ineligible, { ...ineligible.quest, templateId: 'herald-brief' }])
      const capped = await council({ sessionCap: 0 })
      cases.push([capped, capped.quest])
      for (const [c, quest] of cases) {
        await c.presence.goAway(c.guild, null)
        const result = await requestQuestSeal(c.deps, c.guild, quest)
        expect(result.outcome).toBe('requested')
        expect(c.model.calls).toHaveLength(0)
        expect((await c.seals.forQuest(c.guild, c.quest.id))?.evidence).not.toContain('Council')
      }
    })
  })

  test('a passing Verdict requests a Seal bound to the Proposal hash and the Quest round', async () => {
    const g = await gate()
    const proposal = await g.draft('Hello guild')
    const result = await requestQuestSeal(g.deps, g.guild, g.quest)
    expect(result.outcome).toBe('requested')
    const seal = await g.seals.forQuest(g.guild, g.quest.id)
    expect(seal).toMatchObject({
      actionHash: proposal.hash,
      text: 'Hello guild',
      round: g.quest.round,
      status: 'requested',
    })
    expect((await requestQuestSeal(g.deps, g.guild, g.quest)).outcome).toBe('requested')
    expect((await g.seals.forQuest(g.guild, g.quest.id))?.id).toBe(seal?.id)
    expect((await g.quests.get(g.guild, g.quest.id))?.state).toBe('awaiting_seal')
  })

  test('a failing Verdict requests no Seal: a revision round, then the dead letters', async () => {
    const g = await gate(2, { maxLength: 100, bannedTerms: ['free money'], requiredTerms: [] })
    await g.draft('Get free money')
    const first = await requestQuestSeal(g.deps, g.guild, g.quest)
    expect(first.outcome).toBe('rejected')
    expect(await g.seals.forQuest(g.guild, g.quest.id)).toBeNull()
    expect((await g.quests.get(g.guild, g.quest.id))?.state).toBe('queued')
    const again = await g.quests.claim(g.guild, { leaseMs: 60_000, maxActive: 5 })
    const second = await g.quests.submitForSeal(g.guild, g.quest.id, again?.attempts ?? 0)
    await g.draft('More free money')
    await requestQuestSeal(g.deps, g.guild, second)
    expect((await g.quests.get(g.guild, g.quest.id))?.state).toBe('dead')
  })

  test('a revision round with no new Proposal requests no Seal for the denied hash', async () => {
    const g = await gate(2)
    await g.draft('Hello guild')
    await requestQuestSeal(g.deps, g.guild, g.quest)
    const first = await g.seals.forQuest(g.guild, g.quest.id)
    await g.seals.decide(g.guild, first?.id ?? '', {
      verdict: 'denied',
      expectedHash: first?.actionHash ?? '',
    })
    await reconcileSeals(
      {
        quests: g.quests,
        seals: g.seals,
        awaiting: new MemoryAwaitingSealReader(g.quests, g.seals),
      },
      g.guild
    )
    const again = await g.quests.claim(g.guild, { leaseMs: 60_000, maxActive: 5 })
    const second = await g.quests.submitForSeal(g.guild, g.quest.id, again?.attempts ?? 0)
    const result = await requestQuestSeal(g.deps, g.guild, second)
    expect(result.outcome).toBe('rejected')
    expect((await g.seals.forQuest(g.guild, g.quest.id))?.round).toBe(1)
    expect((await g.quests.get(g.guild, g.quest.id))?.lastError).toBe('no_revision')
  })

  test('a Quest with no Proposal is left as it is', async () => {
    const g = await gate()
    expect((await requestQuestSeal(g.deps, g.guild, g.quest)).outcome).toBe('no_proposal')
    expect((await g.quests.get(g.guild, g.quest.id))?.state).toBe('awaiting_seal')
  })
})

describe('requestPendingSeals', () => {
  test('requests a Seal for an awaiting Quest once, never twice for the same round', async () => {
    const config = new MemoryConfigStore(new MemoryClock(new Date('2030-01-01T00:00:00.000Z')))
    const s = await setup()
    await config.seed(s.guild)
    const identityStore = new MemoryIdentityStore()
    identityStore.found(s.guild)
    const identity = new WebAuthnIdentityProvider(identityStore, {
      clock: s.clock,
      keys: new MemoryKeyProvider(),
      rpId: 'localhost',
      rpName: 'Guildhall',
      origin: 'http://localhost:5173',
    })
    const proposals = new ProposalEngine({ store: new MemoryProposalStore(s.clock) })
    await proposals.propose(s.guild, {
      questId: s.quest.id,
      author: 'heralds-member-1',
      kind: 'post',
      content: 'Hello guild',
    })
    const deps = {
      quests: s.quests,
      sealStore: s.seals,
      awaiting: new MemoryAwaitingSealReader(s.quests, s.seals),
      proposals,
      seals: new SealEngine({ store: s.seals, config, identity }),
    }
    expect(await requestPendingSeals(deps, s.guild)).toEqual({ requested: 1 })
    expect((await s.seals.forQuest(s.guild, s.quest.id))?.status).toBe('requested')
    expect(await requestPendingSeals(deps, s.guild)).toEqual({ requested: 0 })
  })

  test('a Quest whose requester is reserved is dead-lettered and the others still get their Seals', async () => {
    const config = new MemoryConfigStore(new MemoryClock(new Date('2030-01-01T00:00:00.000Z')))
    const s = await setup()
    await config.seed(s.guild)
    const identityStore = new MemoryIdentityStore()
    identityStore.found(s.guild)
    const identity = new WebAuthnIdentityProvider(identityStore, {
      clock: s.clock,
      keys: new MemoryKeyProvider(),
      rpId: 'localhost',
      rpName: 'Guildhall',
      origin: 'http://localhost:5173',
    })
    const proposals = new ProposalEngine({ store: new MemoryProposalStore(s.clock) })
    // The poisoned Quest is posted first, so it is met first; its owner is the reserved name.
    const { quest: bad } = await s.quests.post(s.guild, {
      jobKey: 'bad',
      templateId: 'herald-announcement',
      hallId: 'heralds',
      rank: 'apprentice',
      dataClass: 'public',
      title: 'Poisoned',
      ownerId: 'guild-master',
      doneCondition: 'An announcement draft is ready for a Seal',
      roundLimit: 2,
    })
    const claimed = await s.quests.claim(s.guild, { leaseMs: 60_000, maxActive: 5 })
    expect(claimed?.id).toBe(bad.id)
    await s.quests.submitForSeal(s.guild, bad.id, claimed?.attempts ?? 0)
    for (const questId of [bad.id, s.quest.id]) {
      await proposals.propose(s.guild, {
        questId,
        author: 'heralds-member-1',
        kind: 'post',
        content: `Hello ${questId}`,
      })
    }
    const deps = {
      quests: s.quests,
      sealStore: s.seals,
      awaiting: new MemoryAwaitingSealReader(s.quests, s.seals),
      proposals,
      seals: new SealEngine({ store: s.seals, config, identity }),
    }
    expect(await requestPendingSeals(deps, s.guild)).toEqual({ requested: 1 })
    expect((await s.seals.forQuest(s.guild, s.quest.id))?.status).toBe('requested')
    expect(await s.quests.get(s.guild, bad.id)).toMatchObject({
      state: 'dead',
      lastError: 'requester_reserved',
    })
  })

  test('a Quest that cannot be settled does not stop the pass settling the rest', async () => {
    const s = await setup()
    const seal = await s.ask(1)
    await s.seals.decide(s.guild, seal.id, { verdict: 'denied', expectedHash: seal.actionHash })
    const failing = {
      settleSeal: async (): Promise<never> => {
        throw new Error('boom')
      },
    }
    await expect(
      reconcileSeals(
        {
          quests: failing,
          seals: s.seals,
          awaiting: new MemoryAwaitingSealReader(s.quests, s.seals),
        },
        s.guild
      )
    ).resolves.toEqual({
      settled: 0,
    })
  })
})

describe('passes read only what has work', () => {
  test('reconcile does not scan Quests that are waiting on a live Seal', async () => {
    const s = await setup()
    for (let i = 0; i < 30; i++) {
      const { quest } = await s.quests.post(s.guild, {
        jobKey: `waiting-${i}`,
        templateId: 'herald-announcement',
        hallId: 'heralds',
        rank: 'apprentice',
        dataClass: 'public',
        title: `Waiting ${i}`,
        ownerId: 'heralds-member-1',
        doneCondition: 'x',
        roundLimit: 2,
      })
      const claimed = await s.quests.claim(s.guild, { leaseMs: 60_000, maxActive: 50 })
      const held = await s.quests.submitForSeal(s.guild, quest.id, claimed?.attempts ?? 0)
      await s.seals.request(s.guild, {
        questId: held.id,
        requestedBy: 'heralds-member-1',
        kind: 'post',
        text: `Hello ${i}`,
        evidence: 'e',
        round: held.round,
      })
    }
    const seal = await s.ask(1)
    await s.seals.decide(s.guild, seal.id, { verdict: 'approved', expectedHash: seal.actionHash })
    await s.seals.markPosted(s.guild, seal.id, 'Hello', { reauthenticated: true })
    let scanned = 0
    const awaiting = new MemoryAwaitingSealReader(s.quests, s.seals)
    const deps = {
      quests: {
        list: async (): Promise<never> => {
          throw new Error('scanned every held Quest')
        },
        settleSeal: s.quests.settleSeal.bind(s.quests),
      },
      seals: s.seals,
      awaiting: {
        hasWork: awaiting.hasWork.bind(awaiting),
        due: async (...args: Parameters<typeof awaiting.due>) => {
          const page = await awaiting.due(...args)
          scanned += page.items.length
          return page
        },
      },
    }
    expect((await reconcileSeals(deps, s.guild)).settled).toBe(1)
    expect(scanned).toBe(1)
  })
})
