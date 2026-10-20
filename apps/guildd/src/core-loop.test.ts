import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryIdentityStore } from './adapters/memory-identity-provider'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryProposalStore } from './adapters/memory-proposal-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySealStore } from './adapters/memory-seal-store'
import { WebAuthnIdentityProvider } from './adapters/webauthn-identity-provider'
import { reconcileSeals, requestPendingSeals, requestQuestSeal } from './core-loop'
import { SEAL_TTL_MS } from './ports/seal-store'
import { ProposalEngine } from './proposals'
import { SealEngine } from './seals'
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
  const deps = { quests, seals }
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
      proposals,
      seals: new SealEngine({ store: s.seals, config, identity }),
    }
    expect(await requestPendingSeals(deps, s.guild)).toEqual({ requested: 1 })
    expect((await s.seals.forQuest(s.guild, s.quest.id))?.status).toBe('requested')
    expect(await requestPendingSeals(deps, s.guild)).toEqual({ requested: 0 })
  })
})
