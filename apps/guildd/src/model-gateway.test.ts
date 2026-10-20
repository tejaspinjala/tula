import { describe, expect, spyOn, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryGateStore } from './adapters/memory-gate-store'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryModelLedger } from './adapters/memory-model-ledger'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySecretStore } from './adapters/memory-secret-store'
import { MemoryTripwireStore } from './adapters/memory-tripwire-store'
import { defaultConfig, type GuildConfig, guildConfig } from './guild-config'
import { GatewayError, type GatewayErrorCode, ModelGateway, runIdFor } from './model-gateway'
import type { ModelProvider } from './ports/model-provider'
import type { Quest } from './ports/quest-queue'

const GUILD = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const KEY = 'sk-real-provider-key'
const PRICE = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }
const message = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100 }

/** Counts the notices that were first of their guild-day. */
class CountingLedger extends MemoryModelLedger {
  notices = 0
  override async noteCapReached(guildId: string, day: string, reason: string) {
    const first = await super.noteCapReached(guildId, day, reason)
    this.notices += first ? 1 : 0
    return first
  }
}

function config(over: Partial<GuildConfig['caps']> = {}, profile: object = {}): GuildConfig {
  return guildConfig.parse({
    ...defaultConfig(),
    caps: { ...defaultConfig().caps, ...over },
    providers: [
      { id: 'cloud', auth: 'api_key' },
      { id: 'sub', auth: 'subscription' },
    ],
    routingProfiles: [
      {
        id: 'cloud-mid',
        provider: 'cloud',
        tier: 'mid',
        model: 'model-from-config',
        price: PRICE,
        ...profile,
      },
      { id: 'sub-mid', provider: 'sub', tier: 'mid', model: 'sub-model' },
    ],
  })
}

/** Posts a Quest and claims it (attempt 1) with a lease that outlives every test clock jump. */
async function leaseQuest(quests: MemoryQuestQueue, name: string): Promise<Quest> {
  const posted = (
    await quests.post(GUILD, {
      jobKey: name,
      templateId: 'herald-brief',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      title: name,
      ownerId: 'heralds-member-2',
      doneCondition: 'done',
      roundLimit: 2,
    })
  ).quest
  const claimed = await quests.claim(GUILD, {
    leaseMs: 10 * 24 * 3_600_000,
    maxActive: 1000,
    questId: posted.id,
  })
  if (!claimed) {
    throw new Error('expected a lease')
  }
  return claimed
}

async function setup(
  cfg: GuildConfig = config(),
  opts: { withKey?: boolean; subscription?: ModelProvider } = {}
) {
  const clock = new MemoryClock(new Date('2026-03-04T10:00:00.000Z'))
  const ledger = new CountingLedger()
  const provider = new MemoryModelProvider()
  const secrets = new MemorySecretStore(new MemoryKeyProvider())
  if (opts.withKey !== false) {
    await secrets.add(GUILD, 'cloud', KEY)
  }
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const tripwires = new MemoryTripwireStore(clock)
  const gateway = new ModelGateway({
    ledger,
    secrets,
    config: { current: async () => ({ version: 1, config: cfg }) },
    provider,
    ...(opts.subscription ? { subscriptionProvider: opts.subscription } : {}),
    clock,
    tripwires,
    gates: new MemoryGateStore(),
    quests: { get: (g, id) => quests.get(g, id) },
    tokenTtlMs: 60_000,
  })
  const named = new Map<string, Quest>()
  /** The Quest (claimed once, attempt 1) that the run called `name` belongs to. */
  const questFor = async (name: string): Promise<Quest> => {
    const known = named.get(name)
    if (known) {
      return known
    }
    const claimed = await leaseQuest(quests, name)
    named.set(name, claimed)
    return claimed
  }
  const open = async (name = 'run-1', over: Partial<{ profileId: string }> = {}) => {
    const quest = await questFor(name)
    return gateway.openRun(GUILD, {
      questId: quest.id,
      attempt: quest.attempts,
      hallId: 'heralds',
      profileId: 'cloud-mid',
      ...over,
    })
  }
  /** The ledger run id of the run called `name`. */
  const runIdOf = async (name: string) => runIdFor((await questFor(name)).id, 1)
  return { clock, ledger, provider, secrets, gateway, tripwires, open, questFor, runIdOf }
}

async function started(r: Promise<Awaited<ReturnType<ModelGateway['openRun']>>>) {
  const out = await r
  if (out.status !== 'started') {
    throw new Error(`expected started, got ${out.status}`)
  }
  return out
}

async function codeOf(p: Promise<unknown>): Promise<GatewayErrorCode | 'no error'> {
  try {
    await p
  } catch (e) {
    if (e instanceof GatewayError) {
      return e.code
    }
    throw e
  }
  return 'no error'
}

describe('per-run token', () => {
  test('a run calls with its own token; the model id and real key are injected, never returned', async () => {
    const { provider, gateway, open } = await setup()
    provider.script({ ok: true, text: 'answer', usage: { inputTokens: 10, outputTokens: 5 } })
    const run = await started(open())
    const out = await gateway.complete(run.token, message)
    expect(out).toEqual({ text: 'answer', usage: { inputTokens: 10, outputTokens: 5 } })
    expect(provider.seen[0]?.request.model).toBe('model-from-config')
    expect(provider.seen[0]?.credential).toBe(KEY)
    expect(JSON.stringify(out)).not.toContain(KEY)
    expect(run.token).not.toContain(KEY)
  })

  test('the token is stored as a hash, not as itself', async () => {
    const { ledger, open } = await setup()
    const run = await started(open())
    expect(await ledger.findByTokenHash(GUILD, run.token)).toBeNull()
  })

  test('another run, a forged token and a token aimed at another guild are refused', async () => {
    const { provider, gateway, open } = await setup()
    provider.script({ ok: true, text: 'x', usage: { inputTokens: 1, outputTokens: 1 } })
    const run = await started(open())
    expect(await codeOf(gateway.complete('nonsense', message))).toBe('invalid_token')
    expect(await codeOf(gateway.complete(`${run.token}x`, message))).toBe('invalid_token')
    const [prefix, , secret] = run.token.split('.')
    expect(await codeOf(gateway.complete(`${prefix}.${OTHER}.${secret}`, message))).toBe(
      'invalid_token'
    )
    expect(provider.seen).toHaveLength(0)
  })

  test('an expired token is refused', async () => {
    const { clock, gateway, open } = await setup()
    const run = await started(open())
    clock.advance(60_001)
    expect(await codeOf(gateway.complete(run.token, message))).toBe('token_expired')
  })

  test("revoking a run's token stops its next call", async () => {
    const { provider, gateway, open, runIdOf } = await setup()
    provider.script({ ok: true, text: 'x', usage: { inputTokens: 1, outputTokens: 1 } })
    provider.script({ ok: true, text: 'y', usage: { inputTokens: 1, outputTokens: 1 } })
    const run = await started(open())
    await gateway.complete(run.token, message)
    expect(await gateway.revokeRun(GUILD, await runIdOf('run-1'))).toBe(true)
    expect(await codeOf(gateway.complete(run.token, message))).toBe('token_revoked')
    expect(provider.seen).toHaveLength(1)
  })

  test('opening the same run again does not issue a second token', async () => {
    const { open } = await setup()
    await open()
    expect((await open()).status).toBe('exists')
  })
})

describe('metering', () => {
  test('usage is recorded per run, Quest, Hall and day, with dollars from the profile price', async () => {
    const { provider, gateway, ledger, open, questFor, runIdOf } = await setup()
    provider.script({ ok: true, text: 'a', usage: { inputTokens: 200_000, outputTokens: 100_000 } })
    const run = await started(open())
    await gateway.complete(run.token, message)
    for (const by of ['run', 'quest', 'hall', 'day'] as const) {
      const { rows } = await ledger.report(GUILD, by, { limit: 5 })
      expect(rows).toEqual([
        {
          key: {
            run: await runIdOf('run-1'),
            quest: (await questFor('run-1')).id,
            hall: 'heralds',
            day: '2026-03-04',
          }[by],
          calls: 1,
          inputTokens: 200_000,
          outputTokens: 100_000,
          costMicros: 2_100_000,
        },
      ])
    }
  })

  test("a provider failure or an unusable reply keeps the call's estimate as the charge", async () => {
    const { provider, gateway, ledger, open } = await setup()
    provider.script({ ok: false, code: 'unavailable' })
    const run = await started(open())
    expect(await codeOf(gateway.complete(run.token, message))).toBe('provider_failed')
    const first = (await ledger.dayTotals(GUILD, '2026-03-04')).tokens
    expect(first).toBeGreaterThan(100)
    provider.script({ ok: false, code: 'invalid_response' })
    expect(await codeOf(gateway.complete(run.token, message))).toBe('provider_failed')
    expect((await ledger.dayTotals(GUILD, '2026-03-04')).tokens).toBeGreaterThan(first)
  })

  test('an api_key profile with no price is refused, so caps cannot be bypassed', async () => {
    const s = await setup(config({}, { price: undefined }))
    const run = await started(s.open())
    expect(await codeOf(s.gateway.complete(run.token, message))).toBe('price_unconfigured')
  })

  test('a profile with no model id is refused', async () => {
    const s = await setup(config({}, { model: undefined }))
    const run = await started(s.open())
    expect(await codeOf(s.gateway.complete(run.token, message))).toBe('model_unconfigured')
  })

  test('a provider with no key in the Vault is refused', async () => {
    const s = await setup(config(), { withKey: false })
    const run = await started(s.open())
    expect(await codeOf(s.gateway.complete(run.token, message))).toBe('key_missing')
  })

  test('a profile the config does not have is refused', async () => {
    const { open } = await setup()
    expect(await codeOf(open('run-x', { profileId: 'ghost' }))).toBe('unknown_profile')
  })

  test('a subscription provider is refused until spike #15', async () => {
    const { open } = await setup()
    expect(await codeOf(open('run-s', { profileId: 'sub-mid' }))).toBe(
      'subscription_unsupported_until_spike_15'
    )
  })
})

describe('subscription provider', () => {
  const subOpen = (open: (name?: string, over?: { profileId: string }) => Promise<unknown>) =>
    open('run-s', { profileId: 'sub-mid' })

  test('serves the call through the subscription provider with no Vault secret, metered in tokens and unpriced', async () => {
    const subscription = new MemoryModelProvider()
    subscription.script({ ok: true, text: 'from cli', usage: { inputTokens: 40, outputTokens: 9 } })
    const { gateway, ledger, provider, open } = await setup(config(), { subscription })
    const run = await started(open('run-s', { profileId: 'sub-mid' }))
    const out = await gateway.complete(run.token, message)
    expect(out.text).toBe('from cli')
    expect(provider.backendCalls()).toBe(0)
    const { rows } = await ledger.report(GUILD, 'day', { limit: 5 })
    expect(rows).toEqual([
      { key: '2026-03-04', calls: 1, inputTokens: 40, outputTokens: 9, costMicros: null },
    ])
  })

  test('a usage-limit reply is subscription_limit and the estimate stays as the charge', async () => {
    const subscription = new MemoryModelProvider()
    subscription.script({ ok: false, code: 'subscription_limit' })
    const { gateway, ledger, open } = await setup(config(), { subscription })
    const run = await started(subOpen(open))
    expect(await codeOf(gateway.complete(run.token, message))).toBe('subscription_limit')
    expect((await ledger.dayTotals(GUILD, '2026-03-04')).tokens).toBeGreaterThan(100)
  })

  test('any other subscription failure is provider_failed', async () => {
    const subscription = new MemoryModelProvider()
    subscription.script({ ok: false, code: 'unavailable' })
    const { gateway, open } = await setup(config(), { subscription })
    const run = await started(subOpen(open))
    expect(await codeOf(gateway.complete(run.token, message))).toBe('provider_failed')
  })
})

describe('caps', () => {
  test('hitting the token cap queues new runs and the Steward notifies once per day', async () => {
    const { provider, gateway, ledger, open, runIdOf } = await setup(config({ dailyTokens: 200 }))
    provider.script({ ok: true, text: 'big', usage: { inputTokens: 160, outputTokens: 90 } })
    const run = await started(open())
    await gateway.complete(run.token, message)

    expect(await codeOf(gateway.complete(run.token, message))).toBe('cap_reached')
    const q1 = await open('run-2')
    const q2 = await open('run-3')
    expect(q1).toEqual({ status: 'queued', reason: 'daily_tokens' })
    expect(q2.status).toBe('queued')
    expect(await open('run-2')).toEqual({ status: 'queued', reason: 'daily_tokens' })
    expect(ledger.notices).toBe(1)
    expect((await ledger.listQueued(GUILD, 10)).map((r) => r.runId)).toEqual([
      await runIdOf('run-2'),
      await runIdOf('run-3'),
    ])
  })

  test('the daily spend cap queues runs too ($10 default)', async () => {
    const { provider, gateway, open } = await setup(config({ dailyTokens: 10_000_000 }))
    // 1M input at $3 + 600k output at $15 = $12.
    provider.script({
      ok: true,
      text: 'big',
      usage: { inputTokens: 1_000_000, outputTokens: 600_000 },
    })
    const run = await started(open())
    await gateway.complete(run.token, message)
    expect(await open('run-2')).toEqual({ status: 'queued', reason: 'daily_spend' })
  })

  test('queued runs start on the next day and get a token', async () => {
    const { clock, provider, gateway, open, runIdOf } = await setup(config({ dailyTokens: 200 }))
    provider.script({ ok: true, text: 'big', usage: { inputTokens: 160, outputTokens: 90 } })
    const run = await started(open())
    await gateway.complete(run.token, message)
    await open('run-2')
    expect(await gateway.admitQueued(GUILD, 10)).toEqual([])
    clock.advance(24 * 60 * 60 * 1000)
    const admitted = await gateway.admitQueued(GUILD, 10)
    expect(admitted.map((a) => a.runId)).toEqual([await runIdOf('run-2')])
    provider.script({ ok: true, text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } })
    const first = admitted[0]
    expect(first && (await gateway.complete(first.token, message)).text).toBe('ok')
  })

  test('a zero cap queues every run', async () => {
    const { open } = await setup(config({ dailySpendCents: 0 }))
    expect((await open()).status).toBe('queued')
  })
})

describe('reservations and idempotency', () => {
  test('parallel calls against a cap that admits one: one reaches the provider, the rest are cap_reached', async () => {
    const { provider, gateway, open } = await setup(config({ dailyTokens: 150 }))
    provider.script({ ok: true, text: 'one', usage: { inputTokens: 100, outputTokens: 60 } })
    const run = await started(open())
    const codes = await Promise.all(
      Array.from({ length: 5 }, () => codeOf(gateway.complete(run.token, message)))
    )
    expect(provider.seen).toHaveLength(1)
    expect(codes.filter((c) => c === 'cap_reached')).toHaveLength(4)
  })

  test('the same client key twice never makes a second unmetered provider call', async () => {
    const { provider, gateway, ledger, open } = await setup()
    provider.script({ ok: true, text: 'a', usage: { inputTokens: 10, outputTokens: 5 } })
    provider.script({ ok: true, text: 'b', usage: { inputTokens: 10, outputTokens: 5 } })
    const run = await started(open())
    await gateway.complete(run.token, { ...message, idempotencyKey: 'k' })
    expect(await codeOf(gateway.complete(run.token, { ...message, idempotencyKey: 'k' }))).toBe(
      'duplicate_call'
    )
    expect(provider.seen).toHaveLength(1)
    expect((await ledger.dayTotals(GUILD, '2026-03-04')).tokens).toBe(15)
  })

  test('two runs sharing a client key are both metered', async () => {
    const { provider, gateway, ledger, open } = await setup()
    provider.script({ ok: true, text: 'a', usage: { inputTokens: 10, outputTokens: 5 } })
    provider.script({ ok: true, text: 'b', usage: { inputTokens: 10, outputTokens: 5 } })
    const r1 = await started(open('run-1'))
    const r2 = await started(open('run-2'))
    await gateway.complete(r1.token, { ...message, idempotencyKey: 'k' })
    await gateway.complete(r2.token, { ...message, idempotencyKey: 'k' })
    expect((await ledger.dayTotals(GUILD, '2026-03-04')).tokens).toBe(30)
  })

  test('reopening an active run reports exists, even past a cap, with no notice', async () => {
    const { provider, gateway, ledger, open } = await setup(config({ dailyTokens: 200 }))
    provider.script({ ok: true, text: 'big', usage: { inputTokens: 160, outputTokens: 90 } })
    const run = await started(open())
    await gateway.complete(run.token, message)
    expect(await open()).toEqual({ status: 'exists' })
    expect(ledger.notices).toBe(0)
  })

  test('a run revoked by a Hall pause is reissued on the same live attempt once the Hall resumes', async () => {
    const { provider, gateway, tripwires, open } = await setup()
    const first = await started(open())
    const pause = { hallId: 'heralds', tripwire: 'manual', observed: 0, threshold: 0 } as const
    await tripwires.pause(GUILD, pause)
    expect(await gateway.revokeHallRuns(GUILD, 'heralds')).toBe(1)
    expect(await open()).toEqual({ status: 'refused', reason: 'hall_paused' })
    await tripwires.resume(GUILD, 'heralds')
    const second = await started(open())
    expect(second.token).not.toBe(first.token)
    expect(await codeOf(gateway.complete(first.token, message))).toBe('invalid_token')
    provider.script({ ok: true, text: 'again', usage: { inputTokens: 5, outputTokens: 5 } })
    expect((await gateway.complete(second.token, message)).text).toBe('again')
    expect(await open()).toEqual({ status: 'exists' })
  })

  test('a manually revoked run is never reissued, even after a pause/resume cycle', async () => {
    const { gateway, tripwires, open, runIdOf } = await setup()
    const first = await started(open())
    expect(await gateway.revokeRun(GUILD, await runIdOf('run-1'))).toBe(true)
    expect(await open()).toEqual({ status: 'refused', reason: 'token_revoked' })
    const pause = { hallId: 'heralds', tripwire: 'manual', observed: 0, threshold: 0 } as const
    await tripwires.pause(GUILD, pause)
    expect(await gateway.revokeHallRuns(GUILD, 'heralds')).toBe(0)
    await tripwires.resume(GUILD, 'heralds')
    expect(await open()).toEqual({ status: 'refused', reason: 'token_revoked' })
    expect(await codeOf(gateway.complete(first.token, message))).toBe('token_revoked')
  })

  test('a malformed call is invalid_request', async () => {
    const { gateway, open } = await setup()
    const run = await started(open())
    expect(await codeOf(gateway.complete(run.token, { ...message, messages: [] }))).toBe(
      'invalid_request'
    )
  })
})

describe('estimates and settle failures', () => {
  const cjk = '漢'.repeat(100)
  const cjkCall = { messages: [{ role: 'user' as const, content: cjk }], maxTokens: 10 }

  test('the input estimate is the UTF-8 byte length: CJK input covered, a second call over the cap refused', async () => {
    const { provider, gateway, ledger, open } = await setup(config({ dailyTokens: 400 }))
    // 100 characters are 300 bytes; the provider reports no more than the byte count.
    provider.script({ ok: true, text: 'x', usage: { inputTokens: 300, outputTokens: 10 } })
    const run = await started(open())
    await gateway.complete(run.token, cjkCall)
    expect((await ledger.dayTotals(GUILD, '2026-03-04')).tokens).toBeLessThanOrEqual(310)
    expect(await codeOf(gateway.complete(run.token, cjkCall))).toBe('cap_reached')
  })

  test('a CJK input whose byte size alone exceeds the cap never reaches the provider', async () => {
    const { provider, gateway, open } = await setup(config({ dailyTokens: 200 }))
    const run = await started(open())
    expect(await codeOf(gateway.complete(run.token, cjkCall))).toBe('cap_reached')
    expect(provider.seen).toHaveLength(0)
  })

  test('when settle throws, one structured warning is logged and the reply is still returned', async () => {
    class SettleFails extends MemoryModelLedger {
      override async settle(): Promise<void> {
        throw new Error('db down with secret-ish detail')
      }
    }
    const provider = new MemoryModelProvider()
    const clock = new MemoryClock(new Date('2026-03-04T10:00:00.000Z'))
    const quests = new MemoryQuestQueue(clock, () => 0.5)
    const secrets = new MemorySecretStore(new MemoryKeyProvider())
    await secrets.add(GUILD, 'cloud', KEY)
    const gateway = new ModelGateway({
      ledger: new SettleFails(),
      secrets,
      config: { current: async () => ({ version: 1, config: config() }) },
      provider,
      clock,
      tripwires: new MemoryTripwireStore(clock),
      gates: new MemoryGateStore(),
      quests,
    })
    const quest = await leaseQuest(quests, 'run-1')
    const opened = await gateway.openRun(GUILD, {
      questId: quest.id,
      attempt: 1,
      hallId: 'heralds',
      profileId: 'cloud-mid',
    })
    if (opened.status !== 'started') {
      throw new Error('expected started')
    }
    provider.script({ ok: true, text: 'reply', usage: { inputTokens: 1, outputTokens: 1 } })
    const lines: string[] = []
    const spy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk))
      return true
    })
    try {
      const out = await gateway.complete(opened.token, message)
      expect(out.text).toBe('reply')
    } finally {
      spy.mockRestore()
    }
    expect(lines).toHaveLength(1)
    const logged = lines[0] ?? ''
    expect(JSON.parse(logged)).toMatchObject({
      event: 'gateway.settle_failed',
      guildId: GUILD,
      runId: runIdFor(quest.id, 1),
      callKey: expect.any(String),
    })
    expect(logged).not.toContain('secret-ish')
    expect(logged).not.toContain(KEY)
  })
})
