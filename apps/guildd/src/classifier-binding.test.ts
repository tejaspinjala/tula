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
  return {
    ...defaultConfig(),
    providers: [
      { id: 'cloud', auth: 'api_key', privateEligible: false },
      { id: 'home', auth: 'subscription', privateEligible },
    ],
    routingProfiles: [
      { id: 'cloud-mid', provider: 'cloud', tier: 'mid' },
      { id: 'home-cheap', provider: 'home', tier: 'cheap' },
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

  test('a cheap tier on a provider that is not private-eligible binds the stand-in', () => {
    const cfg: GuildConfig = {
      ...configWith(true),
      routingProfiles: [{ id: 'cloud-cheap', provider: 'cloud', tier: 'cheap' }],
    }
    expect(bindClassifier(cfg)).toEqual({ kind: 'standin' })
  })
})

/** A gateway spy: records every classifier call and answers a scripted claim. */
function spyGateway(answer: string) {
  const calls: string[] = []
  return {
    calls,
    classifierComplete: async (_guildId: string, call: { prompt: string }) => {
      calls.push(call.prompt)
      return answer
    },
  }
}

describe('BoundClassifier', () => {
  const claim = '{"hallId":"heralds","rank":"apprentice","dataClass":"public"}'
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

  test('turning the flag off unbinds at once, with no state kept between calls', async () => {
    const s = setup(configWith(true))
    await s.routeFree('one')
    expect(s.gateway.calls).toHaveLength(1)
    s.live.config = configWith(false)
    await s.routeFree('two')
    expect(s.gateway.calls).toHaveLength(1)
  })
})
