import { describe, expect, spyOn, test } from 'bun:test'
import { MemoryActivityLog } from './adapters/memory-activity-log'
import { MemoryAwaitingSealReader } from './adapters/memory-awaiting-seal-reader'
import { MemoryClassifier } from './adapters/memory-classifier'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryGateStore } from './adapters/memory-gate-store'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryModelLedger } from './adapters/memory-model-ledger'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemoryRoutingLog } from './adapters/memory-routing-log'
import { MemorySandboxRunner } from './adapters/memory-sandbox-runner'
import { MemorySealStore } from './adapters/memory-seal-store'
import { MemorySecretStore } from './adapters/memory-secret-store'
import { MemoryTripwireStore } from './adapters/memory-tripwire-store'
import { type DispatchErrorContext, dispatch, dispatchAll, routeClaimed } from './dispatch'
import { defaultConfig, type GuildConfig } from './guild-config'
import { GatewayError, ModelGateway, runIdFor } from './model-gateway'
import { ConfigError } from './ports/config-store'
import type { NewQuest } from './ports/quest-queue'
import type { BlockReason } from './ports/routing-log'
import type { Sandbox, SandboxRunner } from './ports/sandbox-runner'

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

  test.each<[BlockReason, Partial<NewQuest>]>([['hall_not_found', { hallId: 'nowhere' }]])(
    'a permanent block (%s) kills the Quest with that coded reason',
    async (reason, over) => {
      const s = setup()
      const quest = await s.post(over)
      const out = await routeClaimed(s.deps, s.guild, quest)
      expect(out).toEqual({ status: 'blocked', reason, disposition: 'killed' })
      expect(await s.quests.get(s.guild, quest.id)).toMatchObject({
        state: 'dead',
        lastError: reason,
      })
    }
  )

  test('private work with no private-eligible provider waits (queued, retried later), not dead', async () => {
    const s = setup()
    const quest = await s.post({ dataClass: 'private' })
    const out = await routeClaimed(s.deps, s.guild, quest)
    expect(out).toEqual({
      status: 'blocked',
      reason: 'private_provider_unavailable',
      disposition: 'retry_scheduled',
    })
    expect(await s.quests.get(s.guild, quest.id)).toMatchObject({ state: 'queued' })
  })

  test('a locked Hall parks the Quest for a retry instead of killing it', async () => {
    const base = defaultConfig()
    const locked = configWith({
      halls: base.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h)),
    })
    const s = setup(locked)
    const quest = await s.post()
    const out = await routeClaimed(s.deps, s.guild, quest)
    expect(out).toEqual({
      status: 'blocked',
      reason: 'hall_locked',
      disposition: 'retry_scheduled',
    })
    expect(await s.quests.get(s.guild, quest.id)).toMatchObject({ state: 'queued' })
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
    const sealStore = new MemorySealStore(s.clock)
    let barred = false
    const revokedHalls: string[] = []
    const unused = async (): Promise<never> => {
      throw new Error('not used')
    }
    const deps = {
      ...s.deps,
      sealStore,
      awaiting: new MemoryAwaitingSealReader(s.quests, sealStore),
      tripwires: new MemoryTripwireStore(s.clock),
      proposals: {
        latestForQuest: async () => null,
        verdictFor: async () => null,
        listFailedSince: async () => ({ proposals: [], next: null }),
      },
      seals: { requestSeal: unused },
      gates: { isBarred: async () => barred },
      gateway: {
        openRun: async () => ({
          status: 'started' as const,
          token: 'run-token',
          expiresAt: START.toISOString(),
        }),
        revokeRun: async () => true,
        revokeHallRuns: async (_g: string, hallId: string) => {
          revokedHalls.push(hallId)
          return 1
        },
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
      revokedHalls,
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

  test('locking a Hall releases its lease and parks its Quests, and unlocking resumes them', async () => {
    const w = world()
    const base = defaultConfig()
    let config = configWith()
    const deps = { ...w.deps, config: { current: async () => ({ version: 1, config }) } }
    const first = await w.queue()
    const second = await w.queue()
    expect(await dispatch(deps, w.guild)).toMatchObject({ status: 'started', questId: first.id })
    config = configWith({
      halls: base.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h)),
    })
    expect(await dispatch(deps, w.guild)).toEqual({ status: 'idle' })
    expect(await w.started()).toEqual([])
    expect(w.revokedHalls).toContain('heralds')
    for (const q of [first, second]) {
      expect(await w.quests.get(w.guild, q.id)).toMatchObject({
        state: 'queued',
        leaseExpiresAt: null,
      })
    }
    config = configWith()
    expect(await dispatch(deps, w.guild)).toMatchObject({ status: 'started', questId: first.id })
    expect(await dispatch(deps, w.guild)).toMatchObject({ status: 'started', questId: second.id })
  })

  test('a Hall locked at the config change (Quest already queued, lease gone) still has its sandbox killed on the next pass', async () => {
    const w = world()
    const base = defaultConfig()
    let config = configWith()
    const deps = { ...w.deps, config: { current: async () => ({ version: 1, config }) } }
    const quest = await w.queue()
    expect(await dispatch(deps, w.guild)).toMatchObject({ status: 'started', questId: quest.id })
    expect(await w.started()).toEqual([quest.id])
    // What the config store does in the lock transaction.
    await w.quests.releaseLeases(w.guild, 'routing_blocked', ['heralds'])
    config = configWith({
      halls: base.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h)),
    })
    await dispatch(deps, w.guild)
    expect(await w.started()).toEqual([])
  })

  test('a sandbox list that throws is reported and does not stop claims in unlocked Halls', async () => {
    const w = world()
    const base = defaultConfig()
    const inner = new MemorySandboxRunner()
    const reports: string[] = []
    const contexts: unknown[] = []
    const locked = configWith({
      halls: base.halls.map((h) => (h.id === 'health' ? { ...h, locked: true } : h)),
    })
    const deps = {
      ...w.deps,
      config: { current: async () => ({ version: 1, config: locked }) },
      sandboxes: {
        start: (...args: Parameters<MemorySandboxRunner['start']>) => inner.start(...args),
        kill: (...args: Parameters<MemorySandboxRunner['kill']>) => inner.kill(...args),
        list: async (): Promise<never> => {
          throw new Error('docker down')
        },
      },
      onError: (e: unknown, ctx: unknown) => {
        reports.push(e instanceof Error ? e.message : 'other')
        contexts.push(ctx)
      },
    }
    const open = await w.queue()
    await w.queue({ hallId: 'health', templateId: 'health-log' })
    expect(await dispatch(deps, w.guild)).toMatchObject({ status: 'started', questId: open.id })
    expect(reports).toEqual(['docker down'])
    expect(contexts).toEqual([{ kind: 'sandbox_reap', guildId: w.guild }])
  })

  test('a pass whose locked Halls hold no queued or active Quest never lists sandboxes', async () => {
    const w = world()
    const list = spyOn(w.deps.sandboxes, 'list')
    await w.queue()
    await dispatch(w.deps, w.guild)
    await dispatch(w.deps, w.guild)
    expect(list).not.toHaveBeenCalled()
  })

  test('sandboxes of Quests in unlocked Halls are not looked up one by one', async () => {
    const w = world()
    const base = defaultConfig()
    const locked = configWith({
      halls: base.halls.map((h) => (h.id === 'health' ? { ...h, locked: true } : h)),
    })
    const deps = { ...w.deps, config: { current: async () => ({ version: 1, config: locked }) } }
    const parked = await w.queue({ hallId: 'health', templateId: 'health-log' })
    const open = await w.queue()
    await w.deps.sandboxes.start(w.guild, { questId: open.id })
    await w.deps.sandboxes.start(w.guild, { questId: parked.id })
    const get = spyOn(w.quests, 'get')
    await dispatch(deps, w.guild)
    expect(get).not.toHaveBeenCalledWith(w.guild, open.id)
    const left = (await w.deps.sandboxes.list(w.guild)).map((s) => s.questId)
    expect(left).toContain(open.id)
    expect(left).not.toContain(parked.id)
  })

  test('a sandbox that will not die does not stop the lock: the run is revoked, the lease released, other Halls go on', async () => {
    const w = world()
    const inner = new MemorySandboxRunner()
    const reports: string[] = []
    const deps = {
      ...w.deps,
      sandboxes: {
        start: (...args: Parameters<MemorySandboxRunner['start']>) => inner.start(...args),
        list: (guildId: string) => inner.list(guildId),
        kill: async (): Promise<number> => {
          throw new Error('docker down')
        },
      },
      onError: (_e: unknown, ctx: DispatchErrorContext) => {
        reports.push(ctx.kind === 'start_cleanup' ? ctx.questId : '')
      },
    }
    const private_ = await w.queue({ hallId: 'health', templateId: 'health-log' })
    const held = await w.quests.claim(w.guild, { leaseMs: 60_000, maxActive: 5 })
    expect(held?.id).toBe(private_.id)
    const open = await w.queue()
    const out = await dispatch(deps, w.guild)
    expect(out).toMatchObject({ status: 'started', questId: open.id })
    expect(w.revokedHalls).toContain('health')
    expect(await w.quests.get(w.guild, private_.id)).toMatchObject({
      state: 'queued',
      leaseExpiresAt: null,
    })
    expect(reports).toEqual([private_.id])
  })

  test('a guild with no live run in a locked Hall does no kill, revoke or release', async () => {
    const w = world()
    const kill = spyOn(w.deps.sandboxes, 'kill')
    const release = spyOn(w.quests, 'releaseLeases')
    await w.queue()
    await dispatch(w.deps, w.guild)
    await dispatch(w.deps, w.guild)
    expect(kill).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(w.revokedHalls).toEqual([])
  })

  test('dispatchAll skips a guild with no applied config and still starts the configured one', async () => {
    const w = world()
    const quest = await w.queue()
    const ghost = crypto.randomUUID()
    const deps = {
      ...w.deps,
      config: {
        current: async (guildId: string) => {
          if (guildId === ghost) {
            throw new ConfigError('not_found', 0)
          }
          return { version: 1, config: configWith() }
        },
      },
    }
    const results = await dispatchAll({ dispatch: (g) => dispatch(deps, g) }, [ghost, w.guild])
    expect(results.some((r) => 'error' in r)).toBe(false)
    expect(results.find((r) => r.guildId === w.guild)).toMatchObject({
      outcome: { status: 'started', questId: quest.id },
    })
  })

  /** A runner whose start for `hungGuild` waits on a promise the test settles; other guilds start at once. */
  function hangingRunner(hungGuild: string, options: { killFails?: boolean } = {}) {
    const inner = new MemorySandboxRunner()
    let settle: (sandbox: Sandbox) => void = () => {}
    let fail: (error: Error) => void = () => {}
    const pending = new Promise<Sandbox>((resolve, reject) => {
      settle = resolve
      fail = reject
    })
    let sandboxId: string | undefined
    const runner: SandboxRunner = {
      start: (guildId, spec) => {
        if (guildId !== hungGuild) {
          return inner.start(guildId, spec)
        }
        sandboxId = spec.sandboxId
        return pending
      },
      kill: async (target) => {
        if (options.killFails) {
          throw new Error('docker down')
        }
        return inner.kill(target)
      },
      list: (guildId) => inner.list(guildId),
    }
    return {
      runner,
      inner,
      /** The container finally comes up. */
      comeUp: async (guildId: string, questId: string) => {
        settle(await inner.start(guildId, { questId, sandboxId }))
      },
      /** The container is created, then the start call fails. */
      createThenReject: async (guildId: string, questId: string) => {
        await inner.start(guildId, { questId, sandboxId })
        fail(new Error('start_failed'))
      },
    }
  }

  const postOther = (w: ReturnType<typeof world>) => {
    const other = crypto.randomUUID()
    return w.quests
      .post(other, {
        jobKey: crypto.randomUUID(),
        templateId: 'herald-brief',
        hallId: 'heralds',
        rank: 'journeyman',
        dataClass: 'internal',
        title: 'Brief',
        ownerId: 'heralds-member-2',
        doneCondition: 'A draft brief is filed',
        roundLimit: 2,
      })
      .then(() => other)
  }

  test('a sandbox start that never resolves releases its Quest and does not block the next guild', async () => {
    const w = world()
    const hang = hangingRunner(w.guild)
    const deps = { ...w.deps, sandboxes: hang.runner, sandboxStartTimeoutMs: 20 }
    const stuck = await w.queue()
    const other = await postOther(w)
    const results = await dispatchAll({ dispatch: (g) => dispatch(deps, g) }, [w.guild, other])
    expect(results.find((r) => r.guildId === w.guild)).toMatchObject({
      outcome: { status: 'failed', questId: stuck.id, error: 'sandbox_unavailable' },
    })
    expect(results.find((r) => r.guildId === other)).toMatchObject({
      outcome: { status: 'started' },
    })
    expect(await w.quests.get(w.guild, stuck.id)).toMatchObject({
      state: 'queued',
      lastError: 'timeout',
    })
  })

  test('a container that comes up after its start timed out is stopped', async () => {
    const w = world()
    const hang = hangingRunner(w.guild)
    const deps = { ...w.deps, sandboxes: hang.runner, sandboxStartTimeoutMs: 20 }
    const stuck = await w.queue()
    await dispatch(deps, w.guild)
    await hang.comeUp(w.guild, stuck.id)
    await Bun.sleep(5)
    expect(await hang.inner.list(w.guild)).toEqual([])
  })

  test('a start that creates its container and then fails late leaves no container', async () => {
    const w = world()
    const hang = hangingRunner(w.guild)
    const deps = { ...w.deps, sandboxes: hang.runner, sandboxStartTimeoutMs: 20 }
    const stuck = await w.queue()
    await dispatch(deps, w.guild)
    await hang.createThenReject(w.guild, stuck.id)
    await Bun.sleep(5)
    expect(await hang.inner.list(w.guild)).toEqual([])
  })

  test('the timeout revokes the run so its token is dead before any late container', async () => {
    const w = world()
    const hang = hangingRunner(w.guild)
    const revoked: string[] = []
    const deps = {
      ...w.deps,
      sandboxes: hang.runner,
      sandboxStartTimeoutMs: 20,
      gateway: {
        ...w.deps.gateway,
        revokeRun: async (_g: string, runId: string) => {
          revoked.push(runId)
          return true
        },
      },
    }
    const stuck = await w.queue()
    await dispatch(deps, w.guild)
    expect(revoked).toEqual([runIdFor(stuck.id, 1)])
  })

  test('a run opened after the start deadline is refused before the Quest is released', async () => {
    const w = world()
    const secrets = new MemorySecretStore(new MemoryKeyProvider())
    await secrets.add(w.guild, 'cloud', 'sk-key')
    let openLedger: () => void = () => {}
    const ledgerGate = new Promise<void>((resolve) => {
      openLedger = resolve
    })
    class SlowOpenLedger extends MemoryModelLedger {
      override async openRun(...args: Parameters<MemoryModelLedger['openRun']>) {
        await ledgerGate
        return super.openRun(...args)
      }
    }
    const config = configWith({
      routingProfiles: [
        {
          id: 'cloud-mid',
          provider: 'cloud',
          tier: 'mid',
          model: 'm',
          price: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
        },
      ],
    })
    const gateway = new ModelGateway({
      activity: new MemoryActivityLog(),
      ledger: new SlowOpenLedger(),
      secrets,
      config: { current: async () => ({ version: 1, config }) },
      provider: new MemoryModelProvider(),
      clock: w.clock,
      tripwires: new MemoryTripwireStore(w.clock),
      gates: new MemoryGateStore(),
      quests: w.quests,
    })
    const tokens: string[] = []
    let finishRelease: () => void = () => {}
    const releaseGate = new Promise<void>((resolve) => {
      finishRelease = resolve
    })
    const quests = Object.create(w.quests, {
      fail: {
        value: async (...args: Parameters<typeof w.quests.fail>) => {
          await releaseGate
          return w.quests.fail(...args)
        },
      },
    })
    const deps = {
      ...w.deps,
      quests,
      sandboxStartTimeoutMs: 20,
      gateway: {
        openRun: async (...args: Parameters<ModelGateway['openRun']>) => {
          const out = await gateway.openRun(...args)
          if (out.status === 'started') {
            tokens.push(out.token)
          }
          return out
        },
        revokeRun: (...args: Parameters<ModelGateway['revokeRun']>) => gateway.revokeRun(...args),
        revokeHallRuns: async () => 0,
      },
    }
    const stuck = await w.queue()
    const dispatching = dispatch(deps, w.guild)
    await Bun.sleep(40)
    openLedger()
    await Bun.sleep(10)
    // The Quest is not released yet, but the late token must already be dead.
    const [token] = tokens
    if (!token) {
      throw new Error('expected the late openRun to issue a token')
    }
    const err = await gateway
      .complete(token, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 10 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayError)
    expect(err instanceof GatewayError ? err.code : null).toBe('token_revoked')
    finishRelease()
    await dispatching
    expect(await w.quests.get(w.guild, stuck.id)).toMatchObject({ state: 'queued' })
  })

  test('a late kill that fails is reported once, with ids only', async () => {
    const w = world()
    const hang = hangingRunner(w.guild, { killFails: true })
    const reports: Array<{ guildId: string; questId: string; sandboxId: string }> = []
    const deps = {
      ...w.deps,
      sandboxes: hang.runner,
      sandboxStartTimeoutMs: 20,
      onError: (_e: unknown, ctx: DispatchErrorContext) => {
        if (ctx.kind === 'start_cleanup') {
          reports.push(ctx)
        }
      },
    }
    const stuck = await w.queue()
    await dispatch(deps, w.guild)
    await hang.comeUp(w.guild, stuck.id)
    await Bun.sleep(5)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ guildId: w.guild, questId: stuck.id })
  })

  test('a late cleanup whose revoke fails still kills the container, reporting each failure once', async () => {
    const w = world()
    const hang = hangingRunner(w.guild)
    const reports: unknown[] = []
    const deps = {
      ...w.deps,
      sandboxes: hang.runner,
      sandboxStartTimeoutMs: 20,
      gateway: {
        ...w.deps.gateway,
        revokeRun: async (): Promise<boolean> => {
          throw new Error('db down')
        },
      },
      onError: (e: unknown) => {
        reports.push(e)
      },
    }
    const stuck = await w.queue()
    await dispatch(deps, w.guild)
    await hang.comeUp(w.guild, stuck.id)
    await Bun.sleep(5)
    expect(await hang.inner.list(w.guild)).toEqual([])
    // One revoke failure at the deadline, one in the late cleanup.
    expect(reports).toHaveLength(2)
  })

  test('an MCP lease that never resolves releases the Quest and does not block the next guild', async () => {
    const w = world()
    const deps = {
      ...w.deps,
      sandboxStartTimeoutMs: 20,
      mcp: { lease: () => new Promise<never>(() => {}) },
    }
    const stuck = await w.queue()
    const out = await dispatch(deps, w.guild)
    expect(out).toMatchObject({ status: 'failed', questId: stuck.id })
    expect(await w.quests.get(w.guild, stuck.id)).toMatchObject({
      state: 'queued',
      lastError: 'timeout',
    })
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

describe('dispatchAll', () => {
  test('runs one pass per guild and isolates a failing guild', async () => {
    const seen: string[] = []
    const dispatcher = {
      dispatch: async (guildId: string) => {
        seen.push(guildId)
        if (guildId === 'bad') {
          throw new Error('boom')
        }
        return { status: 'idle' as const }
      },
    }
    const results = await dispatchAll(dispatcher, ['a', 'bad', 'c'])
    expect(seen).toEqual(['a', 'bad', 'c'])
    expect(results.map((r) => ('outcome' in r ? r.outcome.status : 'error'))).toEqual([
      'idle',
      'error',
      'idle',
    ])
  })

  test('a guild that never finishes does not hold back the guilds after it', async () => {
    const finished: string[] = []
    const dispatcher = {
      dispatch: async (guildId: string) => {
        if (guildId === 'slow') {
          return new Promise<never>(() => {})
        }
        finished.push(guildId)
        return { status: 'idle' as const }
      },
    }
    void dispatchAll(dispatcher, ['slow', 'b', 'c', 'd', 'e', 'f'])
    await Bun.sleep(10)
    expect(finished).toEqual(['b', 'c', 'd', 'e', 'f'])
  })
})
