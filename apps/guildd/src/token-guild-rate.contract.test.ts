import { afterAll, describe, expect, test } from 'bun:test'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { defaultConfig, guildConfig } from './guild-config'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'

const LIMIT = 2
const NO_LIMIT = { limit: 1_000_000_000, windowMs: 60_000 }
const provider = new MemoryModelProvider()
const harness = await createHarness({
  // Rate-limit counters persist in the shared test database, keyed by window: a window of our
  // own keeps reruns from inheriting a previous run's count.
  now: new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000),
  app: {
    modelProvider: provider,
    rateLimits: {
      ...UNLIMITED_RATE_LIMITS,
      // Every sandbox reaches guildd through the one proxy address, so the client bucket is
      // loose; the guild the token names is what is bounded.
      'gateway-call': { client: NO_LIMIT, guild: { limit: LIMIT, windowMs: 60_000 } },
      mcp: { client: NO_LIMIT, guild: { limit: LIMIT, windowMs: 60_000 } },
    },
  },
})
afterAll(async () => {
  await harness.close()
})

const json = { 'content-type': 'application/json' }

/** A guild with an api_key provider and priced profile. */
async function cloudGuild() {
  const g = await harness.foundGuild({ name: 'Tokens', goal: 'g' })
  const { config } = harness.adapters
  await config.seed(g)
  const proposed = await config.propose(
    g,
    guildConfig.parse({
      ...defaultConfig(),
      providers: [{ id: 'cloud', auth: 'api_key' }],
      routingProfiles: [
        {
          id: 'cloud-mid',
          provider: 'cloud',
          tier: 'mid',
          model: 'configured-model',
          price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
        },
      ],
    })
  )
  if (proposed.status === 'pending') {
    await config.confirm(g, proposed.version)
  }
  await harness.adapters.secrets.add(g, 'cloud', 'sk-test')
  return g
}

async function questIn(g: string) {
  const { quests } = harness.adapters
  const { quest } = await quests.post(g, {
    jobKey: crypto.randomUUID(),
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    title: 'Draft the brief',
    ownerId: 'heralds-member-2',
    doneCondition: 'done',
    roundLimit: 2,
  })
  return quest
}

async function runToken(g: string) {
  const quest = await questIn(g)
  const claimed = await harness.adapters.quests.claim(g, {
    leaseMs: 3_600_000,
    maxActive: 1000,
    questId: quest.id,
  })
  if (!claimed) {
    throw new Error('expected a lease')
  }
  const out = await harness.adapters.gateway.openRun(g, {
    questId: claimed.id,
    attempt: claimed.attempts,
    hallId: 'heralds',
    profileId: 'cloud-mid',
  })
  if (out.status !== 'started') {
    throw new Error(`expected started, got ${out.status}`)
  }
  return out.token
}

const complete = (token: string) => {
  provider.script({ ok: true, text: 'hi', usage: { inputTokens: 1, outputTokens: 1 } })
  return harness.request('/gateway/complete', {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }),
  })
}

const list = async (g: string) => {
  const assignment = await harness.adapters.mcp.assign(g, await questIn(g))
  return harness.request('/mcp', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { assignment },
    }),
  })
}

describe('token-bearing routes are limited per guild named by the verified token', () => {
  test("one guild's run calls exhaust its own bucket, not another guild's", async () => {
    const a = await cloudGuild()
    const b = await cloudGuild()
    const tokenA = await runToken(a)
    const tokenB = await runToken(b)
    for (let i = 0; i < LIMIT; i++) {
      expect((await complete(tokenA)).status).toBe(200)
    }
    const refused = await complete(tokenA)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).not.toBeNull()
    expect((await complete(tokenB)).status).toBe(200)
  })

  test("a forged token naming a guild does not spend that guild's bucket", async () => {
    const a = await cloudGuild()
    const tokenA = await runToken(a)
    const forged = `${tokenA.slice(0, tokenA.lastIndexOf('.') + 1)}${'0'.repeat(64)}`
    for (let i = 0; i < LIMIT + 2; i++) {
      expect((await complete(forged)).status).toBe(401)
    }
    expect((await complete(tokenA)).status).toBe(200)
  })

  test("one guild's MCP calls exhaust its own bucket, not another guild's", async () => {
    const a = await cloudGuild()
    const b = await cloudGuild()
    for (let i = 0; i < LIMIT; i++) {
      expect((await list(a)).status).toBe(200)
    }
    const refused = await list(a)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).not.toBeNull()
    expect((await list(b)).status).toBe(200)
  })

  test('a forged MCP token does not spend any guild bucket', async () => {
    const a = await cloudGuild()
    const forged = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { assignment: 'not-a-signed-token' },
    }
    for (let i = 0; i < LIMIT + 2; i++) {
      const res = await harness.request('/mcp', {
        method: 'POST',
        headers: json,
        body: JSON.stringify(forged),
      })
      expect(res.status).toBe(401)
    }
    expect((await list(a)).status).toBe(200)
  })
})
