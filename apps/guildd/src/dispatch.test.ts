import { describe, expect, test } from 'bun:test'
import { MemoryClassifier } from './adapters/memory-classifier'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryModelLedger } from './adapters/memory-model-ledger'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemoryRoutingLog } from './adapters/memory-routing-log'
import { MemorySandboxRunner } from './adapters/memory-sandbox-runner'
import { MemorySealStore } from './adapters/memory-seal-store'
import { dispatch, routeClaimed } from './dispatch'
import { defaultConfig, type GuildConfig } from './guild-config'
import type { NewQuest } from './ports/quest-queue'
import type { BlockReason } from './ports/routing-log'

const START = new Date('2030-01-01T00:00:00.000Z')
const LEASE = { leaseMs: 60_000, maxActive: 5 }

function configWith(over: Partial<GuildConfig> = {}): GuildConfig {
  const base = defaultConfig()
  return {
    ...base,
    providers: [{ id: 'cloud', auth: 'api_key', privateEligible: false }],
    routingProfiles: [{ id: 'cloud-mid', provider: 'cloud', tier: 'mid' }],
    ...over,
  }
}

function setup(config: GuildConfig = configWith()) {
  const clock = new MemoryClock(START)
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const log = new MemoryRoutingLog()
  const ledger = new MemoryModelLedger()
  const deps = {
    config: { current: async () => ({ version: 1, config }) },
    quests,
    routing: { classifier: new MemoryClassifier(), log, keys: new MemoryKeyProvider() },
    ledger,
    clock,
    random: () => 0.5,
    hosted: false,
  }
  const guild = crypto.randomUUID()
  const post = async (over: Partial<NewQuest> = {}) => {
    await quests.post(guild, {
      jobKey: crypto.randomUUID(),
      templateId: 'herald-brief',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Brief',
      ownerId: 'heralds-member-2',
      doneCondition: 'A draft brief is filed',
      roundLimit: 2,
      ...over,
    })
    const claimed = await quests.claim(guild, LEASE)
    if (!claimed) {
      throw new Error('expected a claim')
    }
    return claimed
  }
  return { clock, quests, ledger, deps, guild, post }
}

describe('routeClaimed', () => {
  test('a routable Quest is routed to a profile and stays claimed', async () => {
    const s = setup()
    const quest = await s.post()
    const out = await routeClaimed(s.deps, s.guild, quest)
    expect(out).toMatchObject({ status: 'routed', profileId: 'cloud-mid' })
    expect((await s.quests.get(s.guild, quest.id))?.state).toBe('active')
  })

  test.each<[BlockReason, Partial<NewQuest>]>([
    ['hall_not_found', { hallId: 'nowhere' }],
    ['private_provider_unavailable', { dataClass: 'private' }],
  ])('a permanent block (%s) kills the Quest with that coded reason', async (reason, over) => {
    const s = setup()
    const quest = await s.post(over)
    const out = await routeClaimed(s.deps, s.guild, quest)
    expect(out).toEqual({ status: 'blocked', reason, disposition: 'killed' })
    expect(await s.quests.get(s.guild, quest.id)).toMatchObject({
      state: 'dead',
      lastError: reason,
    })
  })

  test('a locked Hall kills the Quest and its dependents', async () => {
    const base = defaultConfig()
    const locked = configWith({
      halls: base.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h)),
    })
    const s = setup(locked)
    const quest = await s.post()
    const { quest: child } = await s.quests.post(s.guild, {
      jobKey: 'child',
      templateId: 'herald-brief',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Child',
      ownerId: 'heralds-member-2',
      doneCondition: 'x',
      roundLimit: 1,
      blockedBy: [quest.id],
    })
    await routeClaimed(s.deps, s.guild, quest)
    expect((await s.quests.get(s.guild, quest.id))?.lastError).toBe('hall_locked')
    expect((await s.quests.get(s.guild, child.id))?.lastError).toBe('blocker_dead')
  })

  test('a transient block releases the claim with a jittered notBefore and spends no attempt', async () => {
    const s = setup(configWith({ caps: { dailyTokens: 0, dailySpendCents: 0 } }))
    const quest = await s.post()
    const out = await routeClaimed(s.deps, s.guild, quest)
    expect(out).toEqual({
      status: 'blocked',
      reason: 'budget_exhausted',
      disposition: 'retry_scheduled',
    })
    const after = await s.quests.get(s.guild, quest.id)
    expect(after).toMatchObject({ state: 'queued', attempts: 1, lastError: 'routing_blocked' })
    // attempt 1 backoff with jitter 0.5 is 750ms.
    expect(after?.notBefore).toBe(new Date(START.getTime() + 750).toISOString())
  })
})

describe('dispatch', () => {
  function world(config: GuildConfig = configWith()) {
    const s = setup(config)
    const sandboxes = new MemorySandboxRunner()
    let barred = false
    const unused = async (): Promise<never> => {
      throw new Error('not used')
    }
    const deps = {
      ...s.deps,
      sealStore: new MemorySealStore(s.clock),
      proposals: { latestForQuest: async () => null, verdictFor: async () => null },
      seals: { requestSeal: unused },
      gates: { isBarred: async () => barred },
      gateway: {
        openRun: async () => ({
          status: 'started' as const,
          token: 'run-token',
          expiresAt: START.toISOString(),
        }),
      },
      mcp: {
        lease: async (_g: string, q: { id: string }) => ({
          questId: q.id,
          attempt: 1,
          token: 'lease',
        }),
      },
      sandboxes,
    }
    const queue = async (over: Partial<NewQuest> = {}) =>
      (
        await s.quests.post(s.guild, {
          jobKey: crypto.randomUUID(),
          templateId: 'herald-brief',
          hallId: 'heralds',
          rank: 'journeyman',
          dataClass: 'internal',
          title: 'Brief',
          ownerId: 'heralds-member-2',
          doneCondition: 'A draft brief is filed',
          roundLimit: 2,
          ...over,
        })
      ).quest
    const started = async () => (await sandboxes.list(s.guild)).map((x) => x.questId)
    return {
      ...s,
      deps,
      started,
      queue,
      bar: () => {
        barred = true
      },
    }
  }

  test('an empty queue is idle', async () => {
    const w = world()
    expect(await dispatch(w.deps, w.guild)).toEqual({ status: 'idle' })
  })

  test('claims one Quest, routes it and starts its worker', async () => {
    const w = world()
    const first = await w.queue()
    await w.queue()
    expect(await dispatch(w.deps, w.guild)).toEqual({
      status: 'started',
      questId: first.id,
      profileId: 'cloud-mid',
    })
    expect(await w.started()).toEqual([first.id])
    expect((await w.quests.get(w.guild, first.id))?.state).toBe('active')
  })

  test('a barred guild is refused before anything is claimed', async () => {
    const w = world()
    const quest = await w.queue()
    w.bar()
    expect(await dispatch(w.deps, w.guild)).toEqual({ status: 'barred' })
    expect((await w.quests.get(w.guild, quest.id))?.state).toBe('queued')
  })

  test('a routing block is returned and nothing is started', async () => {
    const w = world(configWith({ caps: { dailyTokens: 0, dailySpendCents: 0 } }))
    const quest = await w.queue()
    expect(await dispatch(w.deps, w.guild)).toEqual({
      status: 'blocked',
      questId: quest.id,
      reason: 'budget_exhausted',
      disposition: 'retry_scheduled',
    })
    expect(await w.started()).toEqual([])
  })
})
