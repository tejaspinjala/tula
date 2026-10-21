import { describe, expect, test } from 'bun:test'
import { MemoryClassifier } from './adapters/memory-classifier'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryRoutingLog } from './adapters/memory-routing-log'
import { ModelClassifier } from './adapters/model-classifier'
import { defaultConfig, type GuildConfig } from './guild-config'
import type { Classifier } from './ports/classifier'
import { type RouteInput, route } from './routing'

const GUILD = '00000000-0000-4000-8000-000000000001'
const ROOMY = { tokensRemaining: 1_000_000, centsRemaining: 1_000_000 }

function configWith(over: Partial<GuildConfig> = {}): GuildConfig {
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
      { id: 'home', auth: 'subscription', privateEligible: true },
    ],
    routingProfiles: [
      { id: 'cloud-mid', provider: 'cloud', tier: 'mid' },
      { id: 'home-mid', provider: 'home', tier: 'mid' },
      { id: 'cloud-cheap', provider: 'cloud', tier: 'cheap' },
    ],
    ...over,
  }
}

function input(over: Partial<RouteInput> = {}): RouteInput {
  return {
    guildId: GUILD,
    decisionKey: crypto.randomUUID(),
    config: configWith(),
    work: { kind: 'template', hallId: 'heralds', rank: 'journeyman', dataClass: 'internal' },
    budgets: { cloud: ROOMY, home: ROOMY },
    available: ['cloud', 'home'],
    hosted: false,
    estimate: { tokens: 1000, cents: 10 },
    ...over,
  }
}

function counting(inner: Classifier): Classifier & { calls: number } {
  const c = {
    calls: 0,
    classify: async (...args: Parameters<Classifier['classify']>) => {
      c.calls += 1
      return inner.classify(...args)
    },
  }
  return c
}

function deps(classifier: Classifier = new MemoryClassifier()) {
  return { classifier, log: new MemoryRoutingLog(), keys: new MemoryKeyProvider() }
}

describe('routing step 1', () => {
  test('a templated Quest routes with zero classifier calls, and is logged', async () => {
    const classifier = counting(new MemoryClassifier())
    const d = deps(classifier)
    const out = await route(input(), d)
    expect(classifier.calls).toBe(0)
    expect(out).toMatchObject({ status: 'routed', providerId: 'cloud', profileId: 'cloud-mid' })
    const page = await d.log.list(GUILD, { limit: 10 })
    expect(page.entries[0]).toMatchObject({
      source: 'template',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      outcome: 'routed',
      providerId: 'cloud',
    })
  })

  test('a classifier claiming public for free text in a work Hall cannot leave private routing', async () => {
    const classifier = counting(
      new MemoryClassifier({ hallId: 'heralds', rank: 'apprentice', dataClass: 'public' })
    )
    const d = deps(classifier)
    const config = configWith({
      providers: [{ id: 'cloud', auth: 'api_key', privateEligible: false }],
      routingProfiles: [{ id: 'cloud-cheap', provider: 'cloud', tier: 'cheap' }],
    })
    const out = await route(input({ config, work: { kind: 'free_text', goal: 'write a post' } }), d)
    expect(classifier.calls).toBe(1)
    expect(out).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
    const [entry] = (await d.log.list(GUILD, { limit: 10 })).entries
    expect(entry).toMatchObject({
      source: 'classifier',
      dataClass: 'private',
      classifierClaim: { dataClass: 'public' },
    })
  })

  test('free text with an explicit Guild Master data class routes on that class', async () => {
    const d = deps(
      new MemoryClassifier({ hallId: 'heralds', rank: 'apprentice', dataClass: 'public' })
    )
    const out = await route(
      input({ work: { kind: 'free_text', goal: 'write a post', dataClass: 'internal' } }),
      d
    )
    expect(out).toMatchObject({ status: 'routed', providerId: 'cloud', dataClass: 'internal' })
  })

  test('a ModelClassifier bound to a non-private provider is refused', () => {
    const model = { complete: async () => '{}' }
    expect(() => new ModelClassifier(model, configWith())).toThrow()
    const privateCheap = configWith({
      routingProfiles: [{ id: 'home-cheap', provider: 'home', tier: 'cheap' }],
    })
    expect(() => new ModelClassifier(model, privateCheap)).not.toThrow()
  })

  test('a classifier failure uses the deterministic fallback, logged as such', async () => {
    const failing: Classifier = {
      classify: async () => {
        throw new Error('model down')
      },
    }
    const d = deps(failing)
    const out = await route(input({ work: { kind: 'free_text', goal: 'anything' } }), d)
    expect(out).toMatchObject({ status: 'routed', providerId: 'home' })
    const [entry] = (await d.log.list(GUILD, { limit: 10 })).entries
    expect(entry).toMatchObject({
      source: 'fallback',
      hallId: 'vault',
      rank: 'apprentice',
      dataClass: 'private',
    })
  })

  test('unclassified free text fails closed without a private-eligible provider', async () => {
    const failing: Classifier = {
      classify: async () => {
        throw new Error('model down')
      },
    }
    const config = configWith({
      providers: [{ id: 'cloud', auth: 'api_key', privateEligible: false }],
      routingProfiles: [{ id: 'cloud-mid', provider: 'cloud', tier: 'mid' }],
    })
    const out = await route(
      input({ config, work: { kind: 'free_text', goal: 'anything' } }),
      deps(failing)
    )
    expect(out).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
    const unknownHall = await route(
      input({ config, work: { kind: 'free_text', goal: 'anything' } }),
      deps(new MemoryClassifier({ hallId: 'nowhere', rank: 'adept', dataClass: 'public' }))
    )
    expect(unknownHall).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
  })

  test('the default MemoryClassifier answer is private', async () => {
    const answer = await new MemoryClassifier().classify({
      guildId: GUILD,
      decisionKey: 'd1',
      goal: 'x',
      halls: [{ id: 'heralds', kind: 'work' }],
    })
    expect(answer.dataClass).toBe('private')
  })

  test('an unknown template data class is treated as private', async () => {
    const out = await route(
      input({
        work: { kind: 'template', hallId: 'heralds', rank: 'journeyman', dataClass: 'Private' },
      }),
      deps()
    )
    expect(out).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
  })

  test('a classifier claiming an unknown data class is treated as private', async () => {
    const claim = JSON.parse('{"hallId":"heralds","rank":"journeyman","dataClass":"Public"}')
    const classifier: Classifier = { classify: async () => claim }
    const out = await route(input({ work: { kind: 'free_text', goal: 'x' } }), deps(classifier))
    expect(out).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
  })

  test('the classifier cannot raise rank: adept is capped at apprentice, claim logged', async () => {
    const d = deps(new MemoryClassifier({ hallId: 'heralds', rank: 'adept', dataClass: 'public' }))
    const out = await route(
      input({ work: { kind: 'free_text', goal: 'x', dataClass: 'internal' } }),
      d
    )
    expect(out).toMatchObject({ status: 'routed', rank: 'apprentice', profileId: 'cloud-cheap' })
    const [entry] = (await d.log.list(GUILD, { limit: 10 })).entries
    expect(entry).toMatchObject({
      rank: 'apprentice',
      classifierClaim: { rank: 'adept' },
    })
  })

  test('a classifier naming an unknown Hall falls back', async () => {
    const d = deps(new MemoryClassifier({ hallId: 'nowhere', rank: 'adept', dataClass: 'public' }))
    await route(input({ work: { kind: 'free_text', goal: 'x' } }), d)
    expect((await d.log.list(GUILD, { limit: 10 })).entries[0]?.source).toBe('fallback')
  })

  test('the goal text is never stored, only its hash', async () => {
    const d = deps()
    await route(input({ work: { kind: 'free_text', goal: 'secret plan' } }), d)
    const [entry] = (await d.log.list(GUILD, { limit: 10 })).entries
    expect(JSON.stringify(entry)).not.toContain('secret plan')
    expect(entry?.goalSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a locked Hall blocks with hall_locked', async () => {
    const out = await route(
      input({ work: { kind: 'template', hallId: 'health', rank: 'adept', dataClass: 'private' } }),
      deps()
    )
    expect(out).toEqual({ status: 'blocked', reason: 'hall_locked' })
  })
})

describe('classifier can only narrow', () => {
  test('a classifier claiming public for a private-Hall template still routes as private', async () => {
    const d = deps(
      new MemoryClassifier({ hallId: 'vault', rank: 'journeyman', dataClass: 'public' })
    )
    const out = await route(
      input({
        work: { kind: 'template', hallId: 'vault', rank: 'journeyman', dataClass: 'public' },
      }),
      d
    )
    expect(out).toMatchObject({ status: 'routed', providerId: 'home', dataClass: 'private' })
  })

  test('a classifier claiming public for free text in a private Hall routes as private', async () => {
    const d = deps(
      new MemoryClassifier({ hallId: 'vault', rank: 'journeyman', dataClass: 'public' })
    )
    const out = await route(input({ work: { kind: 'free_text', goal: 'my labs' } }), d)
    expect(out).toMatchObject({ status: 'routed', providerId: 'home', dataClass: 'private' })
  })

  test('a classifier may narrow to private', async () => {
    const d = deps(
      new MemoryClassifier({ hallId: 'heralds', rank: 'journeyman', dataClass: 'private' })
    )
    const out = await route(input({ work: { kind: 'free_text', goal: 'x' } }), d)
    expect(out).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
  })
})

describe('routing step 2', () => {
  const privateWork = {
    kind: 'template',
    hallId: 'vault',
    rank: 'journeyman',
    dataClass: 'private',
  } as const

  test('private work with no private-eligible provider fails closed and is logged', async () => {
    const config = configWith({
      providers: [{ id: 'cloud', auth: 'api_key', privateEligible: false }],
      routingProfiles: [{ id: 'cloud-mid', provider: 'cloud', tier: 'mid' }],
    })
    const d = deps()
    const out = await route(input({ config, work: privateWork }), d)
    expect(out).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
    expect((await d.log.list(GUILD, { limit: 5 })).entries[0]).toMatchObject({
      outcome: 'blocked',
      reason: 'private_provider_unavailable',
      providerId: null,
    })
  })

  test('private work from a Hall not private-eligible fails closed', async () => {
    const base = configWith()
    const config = {
      ...base,
      halls: base.halls.map((h) => (h.id === 'vault' ? { ...h, privateEligible: false } : h)),
    }
    const out = await route(input({ config, work: privateWork }), deps())
    expect(out).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
  })

  test('failover never leaves the data class', async () => {
    const out = await route(input({ work: privateWork, available: ['cloud'] }), deps())
    expect(out).toEqual({ status: 'blocked', reason: 'no_provider_available' })
  })

  test('failover skips an unavailable provider for non-private work', async () => {
    const out = await route(input({ available: ['home'] }), deps())
    expect(out).toMatchObject({ status: 'routed', providerId: 'home' })
  })

  test('failover never moves work to a provider outside its budget', async () => {
    const budgets = {
      cloud: { tokensRemaining: 10, centsRemaining: 1_000_000 },
      home: { tokensRemaining: 1_000_000, centsRemaining: 0 },
    }
    const out = await route(input({ budgets }), deps())
    expect(out).toMatchObject({ status: 'routed', providerId: 'home' })
    const dry = { ...budgets, home: { tokensRemaining: 5, centsRemaining: 0 } }
    expect(await route(input({ budgets: dry }), deps())).toEqual({
      status: 'blocked',
      reason: 'budget_exhausted',
    })
  })

  test('an api_key provider is also capped in dollars; a subscription one is not', async () => {
    const budgets = {
      cloud: { tokensRemaining: 1_000_000, centsRemaining: 5 },
      home: { tokensRemaining: 1_000_000, centsRemaining: 0 },
    }
    const out = await route(input({ budgets }), deps())
    expect(out).toMatchObject({ providerId: 'home' })
  })

  test('a provider with no budget entry is out of budget', async () => {
    const out = await route(input({ budgets: {} }), deps())
    expect(out).toEqual({ status: 'blocked', reason: 'budget_exhausted' })
  })

  test('budget is checked before availability', async () => {
    const out = await route(input({ budgets: {}, available: [] }), deps())
    expect(out).toEqual({ status: 'blocked', reason: 'budget_exhausted' })
  })

  test('a subscription provider is rejected when the deployment is hosted', async () => {
    const out = await route(input({ hosted: true, available: ['home'] }), deps())
    expect(out).toEqual({ status: 'blocked', reason: 'no_provider_available' })
    const private_ = await route(input({ hosted: true, work: privateWork }), deps())
    expect(private_).toEqual({ status: 'blocked', reason: 'private_provider_unavailable' })
  })

  test('the Member rank picks the tier first', async () => {
    const cheap = await route(
      input({
        work: { kind: 'template', hallId: 'heralds', rank: 'apprentice', dataClass: 'public' },
      }),
      deps()
    )
    expect(cheap).toMatchObject({ profileId: 'cloud-cheap' })
  })

  test('a provider with budget but no availability entry is unavailable', async () => {
    const out = await route(input({ available: [] }), deps())
    expect(out).toEqual({ status: 'blocked', reason: 'no_provider_available' })
  })

  test('the same goal hashes differently in two guilds', async () => {
    const d = deps()
    const other = '00000000-0000-4000-8000-000000000002'
    const work = { kind: 'free_text', goal: 'same goal' } as const
    await route(input({ work }), d)
    await route(input({ work, guildId: other }), d)
    const a = (await d.log.list(GUILD, { limit: 1 })).entries[0]?.goalSha256
    const b = (await d.log.list(other, { limit: 1 })).entries[0]?.goalSha256
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(b).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })

  test('a retried decision key logs once', async () => {
    const d = deps()
    const i = input()
    await route(i, d)
    await route(i, d)
    expect((await d.log.list(GUILD, { limit: 10 })).entries).toHaveLength(1)
  })
})
