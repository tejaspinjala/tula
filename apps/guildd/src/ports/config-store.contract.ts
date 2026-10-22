import { describe, expect, test } from 'bun:test'
import { defaultConfig } from '../guild-config'
import { ConfigError, type ConfigStore } from './config-store'

/** A store under test plus a way to get real guilds (a database-backed store needs them). */
export interface ConfigStoreFixture {
  store: ConfigStore
  /** Founds a guild WITHOUT seeding config; the test seeds it. */
  newGuild: () => Promise<string>
  /** Posts a Quest in `hallId` and claims it, so it is `active` under a lease; returns a reader of its current state. */
  activeQuest: (
    guildId: string,
    hallId: string
  ) => Promise<{
    read: () => Promise<{
      state: string
      leaseExpiresAt: string | null
      attempts: number
      refunds: number
    }>
  }>
  /**
   * Posts a Quest, claims it and releases the claim for an hour (a routing wait); returns a reader of
   * whether its wait is over now and of its attempt count.
   */
  routingWait: (
    guildId: string,
    hallId: string
  ) => Promise<{ read: () => Promise<{ awake: boolean; attempts: number; refunds: number }> }>
  /** Opens an active model run in `hallId`, wired to the same ledger the store revokes in; returns a reader of its state. */
  liveRun: (guildId: string, hallId: string) => Promise<{ read: () => Promise<string> }>
}

/** The ConfigStore contract, run against every adapter. `make` returns a fresh store. */
export function configStoreContract(name: string, make: () => Promise<ConfigStoreFixture>) {
  describe(`ConfigStore contract: ${name}`, () => {
    async function seeded() {
      const fx = await make()
      const guild = await fx.newGuild()
      await fx.store.seed(guild)
      return { store: fx.store, guild, make: fx }
    }

    test('a seeded guild is at version 1 with the default config; seeding twice changes nothing', async () => {
      const { store, guild } = await seeded()
      await store.seed(guild)
      expect(await store.current(guild)).toEqual({ version: 1, config: defaultConfig() })
      const history = await store.history(guild, { limit: 10 })
      expect(history.versions.map((v) => [v.version, v.kind, v.status])).toEqual([
        [1, 'seed', 'applied'],
      ])
    })

    test('propose refuses autonomous with seal_policy_locked and stores nothing', async () => {
      const { store, guild } = await seeded()
      const locked = { ...defaultConfig(), sealPolicy: 'autonomous' as const }
      const error = await store.propose(guild, locked).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ConfigError)
      expect(error instanceof ConfigError ? error.code : null).toBe('seal_policy_locked')
      expect((await store.history(guild, { limit: 10 })).versions).toHaveLength(1)
    })

    test('a tightening change applies immediately as a new version', async () => {
      const { store, guild } = await seeded()
      const tighter = { ...defaultConfig(), caps: { dailyTokens: 10, dailySpendCents: 10 } }
      expect(await store.propose(guild, tighter)).toEqual({
        version: 2,
        status: 'applied',
        change: 'tightening',
      })
      expect((await store.current(guild)).config.caps.dailyTokens).toBe(10)
    })

    test('a change that locks a Hall releases its leases at once, with no dispatch pass', async () => {
      const { store, guild, make } = await seeded()
      const quest = await make.activeQuest(guild, 'heralds')
      const other = await make.activeQuest(guild, 'other-hall')
      const run = await make.liveRun(guild, 'heralds')
      const otherRun = await make.liveRun(guild, 'other-hall')
      const before = await quest.read()
      expect(before.state).toBe('active')
      const config = (await store.current(guild)).config
      const halls = config.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h))
      await store.propose(guild, { ...config, halls })
      const after = await quest.read()
      expect(after).toMatchObject({ state: 'queued', leaseExpiresAt: null })
      // The claim is refunded: one more refund, so the charged attempts (attempts - refunds) drop by the claim it cost.
      expect(after.attempts).toBe(before.attempts)
      expect(after.refunds).toBe(before.refunds + 1)
      expect(after.attempts - after.refunds).toBe(before.attempts - before.refunds - 1)
      expect((await other.read()).state).toBe('active')
      expect(await run.read()).toBe('revoked')
      expect(await otherRun.read()).toBe('active')
    })

    test('an applied provider or routing profile change ends every routing wait at once; a pending one does not until confirmed', async () => {
      const { store, guild, make } = await seeded()
      const waiting = await make.routingWait(guild, 'heralds')
      const before = await waiting.read()
      expect(before.awake).toBe(false)
      const config = (await store.current(guild)).config
      const withProvider = {
        ...config,
        providers: [{ id: 'home', auth: 'api_key' as const, privateEligible: false }],
      }
      const proposed = await store.propose(guild, withProvider)
      expect(proposed.status).toBe('pending')
      expect((await waiting.read()).awake).toBe(false)
      await store.confirm(guild, proposed.version)
      expect(await waiting.read()).toEqual({ ...before, awake: true })
      const second = await make.routingWait(guild, 'heralds')
      await store.propose(guild, config)
      expect((await second.read()).awake).toBe(true)
    })

    test('making a Hall private-eligible ends routing waits once applied', async () => {
      const { store, guild, make } = await seeded()
      const waiting = await make.routingWait(guild, 'heralds')
      const config = (await store.current(guild)).config
      const halls = config.halls.map((h) =>
        h.id === 'heralds' ? { ...h, privateEligible: true } : h
      )
      const proposed = await store.propose(guild, { ...config, halls })
      expect(proposed.status).toBe('pending')
      expect((await waiting.read()).awake).toBe(false)
      await store.confirm(guild, proposed.version)
      expect((await waiting.read()).awake).toBe(true)
    })

    test('a change to caps or Seal Policy leaves routing waits backed off; another guild is untouched', async () => {
      const { store, guild, make } = await seeded()
      const other = await make.newGuild()
      await store.seed(other)
      const waiting = await make.routingWait(guild, 'heralds')
      const elsewhere = await make.routingWait(other, 'heralds')
      const config = (await store.current(guild)).config
      await store.propose(guild, { ...config, caps: { dailyTokens: 5, dailySpendCents: 5 } })
      const looser = await store.propose(guild, {
        ...config,
        caps: { dailyTokens: 5, dailySpendCents: 5 },
        sealPolicy: 'routine_alone',
      })
      await store.confirm(guild, looser.version)
      expect((await waiting.read()).awake).toBe(false)
      const providers = [{ id: 'home', auth: 'api_key' as const, privateEligible: false }]
      const added = await store.propose(guild, { ...config, providers })
      await store.confirm(guild, added.version)
      expect((await waiting.read()).awake).toBe(true)
      expect((await elsewhere.read()).awake).toBe(false)
    })

    test('a widening change that also locks a Hall releases its leases on confirm, not before', async () => {
      const { store, guild, make } = await seeded()
      const quest = await make.activeQuest(guild, 'heralds')
      const config = (await store.current(guild)).config
      const halls = config.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h))
      const proposed = await store.propose(guild, {
        ...config,
        halls,
        caps: {
          dailyTokens: config.caps.dailyTokens * 2,
          dailySpendCents: config.caps.dailySpendCents * 2,
        },
      })
      expect(proposed.status).toBe('pending')
      expect((await quest.read()).state).toBe('active')
      await store.confirm(guild, proposed.version)
      expect(await quest.read()).toMatchObject({ state: 'queued', leaseExpiresAt: null })
    })

    test('a widening change is stored pending and leaves the config in force alone until confirmed', async () => {
      const { store, guild } = await seeded()
      const looser = { ...defaultConfig(), sealPolicy: 'routine_alone' as const }
      expect(await store.propose(guild, looser)).toEqual({
        version: 2,
        status: 'pending',
        change: 'widening',
      })
      expect((await store.current(guild)).config.sealPolicy).toBe('always')
      expect((await store.get(guild, 2))?.status).toBe('pending')
      await store.confirm(guild, 2)
      expect(await store.current(guild)).toEqual({ version: 2, config: looser })
      expect((await store.get(guild, 2))?.status).toBe('applied')
    })

    test('confirm refuses an applied version, an unknown one and a stale one', async () => {
      const { store, guild } = await seeded()
      const looser = { ...defaultConfig(), sealPolicy: 'routine_alone' as const }
      await store.propose(guild, looser)
      await store.propose(guild, {
        ...defaultConfig(),
        caps: { dailyTokens: 5, dailySpendCents: 5 },
      })
      await expect(store.confirm(guild, 3)).rejects.toMatchObject({ code: 'not_pending' })
      await expect(store.confirm(guild, 99)).rejects.toMatchObject({ code: 'not_found' })
      await expect(store.confirm(guild, 2)).rejects.toBeInstanceOf(ConfigError)
      await expect(store.confirm(guild, 2)).rejects.toMatchObject({ code: 'stale' })
      expect((await store.current(guild)).config.sealPolicy).toBe('always')
    })

    test('an earlier version can be restored as a new version', async () => {
      const { store, guild } = await seeded()
      await store.propose(guild, {
        ...defaultConfig(),
        caps: { dailyTokens: 5, dailySpendCents: 5 },
      })
      // Restoring v1 raises caps again, so it is a widening change and stays pending.
      expect(await store.restore(guild, 1)).toEqual({
        version: 3,
        status: 'pending',
        change: 'widening',
      })
      await store.confirm(guild, 3)
      expect((await store.current(guild)).config).toEqual(defaultConfig())
      expect((await store.get(guild, 3))?.kind).toBe('restore')
      await expect(store.restore(guild, 42)).rejects.toMatchObject({ code: 'not_found' })
    })

    test('history is newest first and paginated', async () => {
      const { store, guild } = await seeded()
      for (const n of [1, 2, 3]) {
        await store.propose(guild, {
          ...defaultConfig(),
          caps: { dailyTokens: n, dailySpendCents: 1 },
        })
      }
      const first = await store.history(guild, { limit: 2 })
      expect(first.versions.map((v) => v.version)).toEqual([4, 3])
      expect(first.next).toBe(3)
      const second = await store.history(guild, { after: first.next ?? 0, limit: 2 })
      expect(second.versions.map((v) => v.version)).toEqual([2, 1])
      expect(second.next).toBeNull()
    })

    test('two proposals in the same tick both land with distinct versions', async () => {
      const { store, guild } = await seeded()
      const a = { ...defaultConfig(), caps: { dailyTokens: 1, dailySpendCents: 1 } }
      const b = { ...defaultConfig(), caps: { dailyTokens: 2, dailySpendCents: 1 } }
      const results = await Promise.all([store.propose(guild, a), store.propose(guild, b)])
      expect(results.map((r) => r.version).sort()).toEqual([2, 3])
    })

    test('guilds do not see each other', async () => {
      const fx = await make()
      const one = await fx.newGuild()
      const two = await fx.newGuild()
      await fx.store.seed(one)
      await fx.store.seed(two)
      await fx.store.propose(one, {
        ...defaultConfig(),
        caps: { dailyTokens: 1, dailySpendCents: 1 },
      })
      expect((await fx.store.current(two)).version).toBe(1)
      expect(await fx.store.get(two, 2)).toBeNull()
      expect((await fx.store.history(two, { limit: 10 })).versions).toHaveLength(1)
    })

    test('propose with a base version that is no longer in force is refused as stale and stores nothing', async () => {
      const { store, guild } = await seeded()
      const tighter = { ...defaultConfig(), caps: { dailyTokens: 10, dailySpendCents: 10 } }
      await store.propose(guild, tighter)
      const error = await store
        .propose(guild, defaultConfig(), { baseVersion: 1 })
        .catch((e: unknown) => e)
      expect(error instanceof ConfigError ? error.code : null).toBe('stale')
      expect((await store.history(guild, { limit: 10 })).versions).toHaveLength(2)
      const ok = await store.propose(guild, tighter, { baseVersion: 2 })
      expect(ok.version).toBe(3)
    })

    test('an unseeded guild has no config', async () => {
      const fx = await make()
      const guild = await fx.newGuild()
      await expect(fx.store.current(guild)).rejects.toMatchObject({ code: 'not_found' })
    })
  })
}
