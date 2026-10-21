import { describe, expect, test } from 'bun:test'
import { BoundClassifier } from './adapters/bound-classifier'
import { MemoryClassifier } from './adapters/memory-classifier'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryRoutingLog } from './adapters/memory-routing-log'
import { bindClassifier } from './classifier-binding'
import { defaultConfig, type GuildConfig } from './guild-config'
import { route } from './routing'

const GUILD = '00000000-0000-4000-8000-000000000001'
const ROOMY = { tokensRemaining: 1_000_000, centsRemaining: 1_000_000 }

function configWith(privateEligible: boolean): GuildConfig {
  const base = defaultConfig()
  return {
    ...base,
    halls: [
      ...base.halls,
      {
        id: 'vault',
        name: 'Vault',
        kind: 'private',
        locked: false,
        privateEligible: true,
        captain: null,
        members: [],
      },
    ],
    providers: [
      { id: 'cloud', auth: 'api_key', privateEligible: false },
      { id: 'home', auth: 'subscription', privateEligible },
    ],
    routingProfiles: [
      { id: 'cloud-mid', provider: 'cloud', tier: 'mid' },
      { id: 'home-cheap', provider: 'home', tier: 'cheap' },
      { id: 'home-mid', provider: 'home', tier: 'mid' },
    ],
  }
}

describe('bindClassifier', () => {
  test('no private-eligible provider binds the stand-in', () => {
    expect(bindClassifier(configWith(false))).toEqual({ kind: 'standin' })
  })

  test('a private-eligible provider with a cheap tier binds the model on it', () => {
    expect(bindClassifier(configWith(true))).toEqual({
      kind: 'model',
      providerId: 'home',
      profileId: 'home-cheap',
    })
  })

  test('binds to the first cheap profile whose provider is private-eligible', () => {
    const cfg: GuildConfig = {
      ...configWith(true),
      routingProfiles: [
        { id: 'a-cheap', provider: 'cloud', tier: 'cheap' },
        { id: 'b-cheap', provider: 'home', tier: 'cheap' },
      ],
    }
    expect(bindClassifier(cfg)).toEqual({ kind: 'model', providerId: 'home', profileId: 'b-cheap' })
  })

  test('a cheap tier on a provider that is not private-eligible binds the stand-in', () => {
    const cfg: GuildConfig = {
      ...configWith(true),
      routingProfiles: [{ id: 'cloud-cheap', provider: 'cloud', tier: 'cheap' }],
    }
    expect(bindClassifier(cfg)).toEqual({ kind: 'standin' })
  })
})

/** A gateway spy: records every classifier call and answers a scripted claim. */
function spyGateway(answer: string, hang = false) {
  const calls: string[] = []
  const halls: string[] = []
  const aborted: boolean[] = []
  return {
    calls,
    halls,
    aborted,
    classifierComplete: async (
      _guildId: string,
      call: { prompt: string; hallId: string; signal?: AbortSignal }
    ) => {
      calls.push(call.prompt)
      halls.push(call.hallId)
      if (hang) {
        await new Promise<void>((resolve) => {
          call.signal?.addEventListener('abort', () => {
            aborted.push(true)
            resolve()
          })
        })
      }
      return answer
    },
  }
}

describe('BoundClassifier', () => {
  const claim = '{"hallId":"vault","rank":"apprentice","dataClass":"public"}'
  function setup(initial: GuildConfig) {
    const live = { config: initial }
    const gateway = spyGateway(claim)
    const classifier = new BoundClassifier({
      config: { current: async () => ({ version: 1, config: live.config }) },
      gateway,
      standin: new MemoryClassifier(),
    })
    const routeFree = (goal: string) =>
      route(
        {
          guildId: GUILD,
          decisionKey: crypto.randomUUID(),
          config: live.config,
          work: { kind: 'free_text', goal },
          budgets: { cloud: ROOMY, home: ROOMY },
          available: ['cloud', 'home'],
          hosted: false,
          estimate: { tokens: 1, cents: 1 },
        },
        { classifier, log: new MemoryRoutingLog(), keys: new MemoryKeyProvider() }
      )
    return { live, gateway, routeFree }
  }

  test('with no private-eligible provider, free text routes as private and no model call is made', async () => {
    const s = setup(configWith(false))
    const out = await s.routeFree('secret plan')
    expect(s.gateway.calls).toHaveLength(0)
    if (out.status === 'routed') {
      expect(out.dataClass).toBe('private')
    }
  })

  test('a model claim of public on free text never makes the Quest public', async () => {
    const s = setup(configWith(true))
    const out = await s.routeFree('secret plan')
    expect(s.gateway.calls).toHaveLength(1)
    expect(s.gateway.calls[0]).toContain('secret plan')
    expect(out).toMatchObject({ status: 'routed', dataClass: 'private', providerId: 'home' })
  })

  test('spend is filed under the first open work Hall, not a private one listed first', async () => {
    const s = setup(configWith(true))
    const vault = s.live.config.halls.find((h) => h.id === 'vault')
    const rest = s.live.config.halls.filter((h) => h.id !== 'vault')
    if (vault) {
      s.live.config = { ...s.live.config, halls: [vault, ...rest] }
    }
    await s.routeFree('plan')
    const firstWork = s.live.config.halls.find((h) => h.kind === 'work' && !h.locked)
    expect(s.gateway.halls[0]).toBe(firstWork?.id)
  })

  test("another guild's private-eligible config never binds this guild's classifier", async () => {
    const gateway = spyGateway(claim)
    const classifier = new BoundClassifier({
      config: {
        current: async (guildId) => ({ version: 1, config: configWith(guildId !== GUILD) }),
      },
      gateway,
      standin: new MemoryClassifier(),
    })
    await classifier.classify({
      guildId: GUILD,
      decisionKey: 'k',
      goal: 'plan',
      halls: [{ id: 'heralds', kind: 'work' }],
    })
    expect(gateway.calls).toHaveLength(0)
  })

  test('the classifier timeout aborts the gateway call', async () => {
    const gateway = spyGateway(claim, true)
    const classifier = new BoundClassifier({
      config: { current: async () => ({ version: 1, config: configWith(true) }) },
      gateway,
      standin: new MemoryClassifier(),
      timeoutMs: 20,
    })
    await expect(
      classifier.classify({
        guildId: GUILD,
        decisionKey: 'k',
        goal: 'plan',
        halls: [{ id: 'heralds', kind: 'work' }],
      })
    ).rejects.toThrow()
    expect(gateway.aborted).toEqual([true])
  })

  test('turning the flag off unbinds at once, with no state kept between calls', async () => {
    const s = setup(configWith(true))
    await s.routeFree('one')
    expect(s.gateway.calls).toHaveLength(1)
    s.live.config = configWith(false)
    await s.routeFree('two')
    expect(s.gateway.calls).toHaveLength(1)
  })
})
