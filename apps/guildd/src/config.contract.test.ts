import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { eventsAfter } from './events'
import { defaultConfig, guildConfig } from './guild-config'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
const devHarness = await createHarness({ devGuildHeader: true })
const subscriptionHarness = await createHarness({
  devGuildHeader: false,
  app: { subscriptionProvider: new MemoryModelProvider() },
})
afterAll(async () => {
  await harness.close()
  await devHarness.close()
  await subscriptionHarness.close()
})

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const session = z.object({ token: z.string(), guildId: z.string() })
const foundedBody = z.object({ id: z.string(), foundingToken: z.string() })
const proofBody = z.object({ proof: z.string() })
const configBody = z.object({ version: z.number(), config: guildConfig })
const outcome = z.object({
  version: z.number(),
  status: z.enum(['applied', 'pending']),
  change: z.string(),
})
const versionsBody = z.object({
  versions: z.array(z.object({ version: z.number(), status: z.string(), kind: z.string() })),
  next: z.number().nullable(),
})
const rosterBody = z.object({
  steward: z.object({ id: z.string(), name: z.string() }),
  halls: z.array(
    z.object({
      id: z.string(),
      locked: z.boolean(),
      captain: z.unknown(),
      members: z.array(z.unknown()),
    })
  ),
  next: z.string().nullable(),
})

function send(h: typeof harness, method: string, path: string, body?: unknown, headers = {}) {
  return h.request(path, {
    method,
    headers: { ...json, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function signedIn(h: typeof harness = harness) {
  const founded = foundedBody.parse(
    await (await send(h, 'POST', '/guilds', { name: 'Config', goal: 'g' })).json()
  )
  const guildId = founded.id
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const reg = ceremony.parse(
    await (
      await send(
        h,
        'POST',
        `/guilds/${guildId}/passkeys/begin`,
        {},
        { 'x-founding-token': founded.foundingToken }
      )
    ).json()
  )
  await send(h, 'POST', `/guilds/${guildId}/passkeys/finish`, {
    challengeId: reg.challengeId,
    response: await key.register(reg.options),
  })
  const begin = ceremony.parse(
    await (await send(h, 'POST', `/guilds/${guildId}/sign-in/begin`, {})).json()
  )
  const res = await send(h, 'POST', `/guilds/${guildId}/sign-in/finish`, {
    challengeId: begin.challengeId,
    response: await key.assert(begin.options),
  })
  const { token } = session.parse(await res.json())
  const auth = { authorization: `Bearer ${token}` }
  return {
    guildId,
    auth,
    base: `/guilds/${guildId}`,
    async proof() {
      const b = ceremony.parse(
        await (await send(h, 'POST', '/session/reauth/begin', {}, auth)).json()
      )
      const done = await send(
        h,
        'POST',
        '/session/reauth/finish',
        { challengeId: b.challengeId, response: await key.assert(b.options) },
        auth
      )
      return proofBody.parse(await done.json()).proof
    },
    /** PUTs `config` against the version in force now, as a client that just loaded it would. */
    async put(config: unknown) {
      const { version } = await this.current()
      return send(h, 'PUT', `/guilds/${guildId}/config`, { config, baseVersion: version }, auth)
    },
    async current() {
      return configBody.parse(
        await (await send(h, 'GET', `/guilds/${guildId}/config`, undefined, auth)).json()
      )
    },
  }
}

describe('subscription providers in a saved config', () => {
  const withSubscription = () => ({
    ...defaultConfig(),
    providers: [{ id: 'home', auth: 'subscription' as const, privateEligible: false }],
    routingProfiles: [],
  })

  test('are refused as subscription_disabled while the host has not enabled them', async () => {
    const who = await signedIn()
    const res = await who.put(withSubscription())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'subscription_disabled' })
    expect((await who.current()).version).toBe(1)
  })

  test('are accepted once the host enables them', async () => {
    const who = await signedIn(subscriptionHarness)
    const res = await who.put(withSubscription())
    expect(res.status).toBeLessThan(300)
  })
})

describe('restoring a version that names a subscription provider', () => {
  const restoreOf = async (h: typeof harness) => {
    const who = await signedIn(h)
    await h.adapters.config.propose(who.guildId, {
      ...defaultConfig(),
      providers: [{ id: 'home', auth: 'subscription', privateEligible: false }],
      routingProfiles: [],
    })
    // Version 2 names the subscription provider; move on so it is an earlier version.
    await h.adapters.config.propose(who.guildId, {
      ...defaultConfig(),
      caps: { dailyTokens: 5, dailySpendCents: 5 },
    })
    return send(h, 'POST', `${who.base}/config/versions/2/restore`, {}, who.auth)
  }

  test('is refused as subscription_disabled while the host has not enabled them', async () => {
    const res = await restoreOf(harness)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'subscription_disabled' })
  })

  test('works once the host enables them', async () => {
    expect((await restoreOf(subscriptionHarness)).status).toBeLessThan(300)
  })
})

describe('provider private eligibility over HTTP', () => {
  const withProvider = (privateEligible: boolean) => ({
    ...defaultConfig(),
    providers: [{ id: 'home', auth: 'api_key' as const, privateEligible }],
    routingProfiles: [],
  })

  test('turning it on is pending until a passkey confirm, and turning it off applies at once', async () => {
    const who = await signedIn()
    const put = (config: unknown) => who.put(config)
    expect((await put(withProvider(false))).status).toBe(202)
    const base = await who.proof()
    await send(
      harness,
      'POST',
      `${who.base}/config/versions/2/confirm`,
      {},
      { ...who.auth, 'x-reauth-proof': base }
    )
    const on = await put(withProvider(true))
    expect(on.status).toBe(202)
    expect((await who.current()).config.providers[0]?.privateEligible).toBe(false)
    const confirm = await send(
      harness,
      'POST',
      `${who.base}/config/versions/3/confirm`,
      {},
      { ...who.auth, 'x-reauth-proof': await who.proof() }
    )
    expect(confirm.status).toBe(200)
    expect((await who.current()).config.providers[0]?.privateEligible).toBe(true)
    const off = await put(withProvider(false))
    expect(off.status).toBe(200)
    expect(outcome.parse(await off.json())).toMatchObject({
      status: 'applied',
      change: 'tightening',
    })
    expect((await who.current()).config.providers[0]?.privateEligible).toBe(false)
  })

  test("a second guild neither reads nor changes the first guild's providers", async () => {
    const first = await signedIn()
    const second = await signedIn()
    await first.put(withProvider(false))
    await send(
      harness,
      'POST',
      `${first.base}/config/versions/2/confirm`,
      {},
      { ...first.auth, 'x-reauth-proof': await first.proof() }
    )
    expect((await second.current()).config.providers).toEqual([])
    const read = await send(harness, 'GET', `${first.base}/config`, undefined, second.auth)
    expect(read.status).toBe(404)
    const write = await send(
      harness,
      'PUT',
      `${first.base}/config`,
      { config: withProvider(true), baseVersion: 2 },
      second.auth
    )
    expect(write.status).toBe(404)
    expect((await first.current()).version).toBe(2)
  })
})

describe('config PUT with a base version', () => {
  test('a change made after the caller read the config is refused as stale, not clobbered', async () => {
    const who = await signedIn()
    const put = (body: unknown) => send(harness, 'PUT', `${who.base}/config`, body, who.auth)
    const tighter = { ...defaultConfig(), caps: { dailyTokens: 10, dailySpendCents: 10 } }
    expect((await put({ config: tighter, baseVersion: 1 })).status).toBe(200)
    const stale = await put({ config: defaultConfig(), baseVersion: 1 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'stale' })
    expect((await who.current()).config.caps.dailyTokens).toBe(10)
    const fresh = await put({ config: tighter, baseVersion: 2 })
    expect(fresh.status).toBe(200)
  })

  test('a save without a base version is refused as invalid, naming baseVersion', async () => {
    const who = await signedIn()
    const res = await send(
      harness,
      'PUT',
      `${who.base}/config`,
      { config: defaultConfig() },
      who.auth
    )
    expect(res.status).toBe(400)
    const body = z
      .object({ issues: z.array(z.object({ path: z.array(z.unknown()) })) })
      .parse(await res.json())
    expect(body.issues.map((i) => i.path)).toContainEqual(['baseVersion'])
  })
})

describe('provider status vendor', () => {
  const otherHarness = createHarness({
    devGuildHeader: false,
    app: { modelProvider: new MemoryModelProvider('Other') },
  })
  afterAll(async () => (await otherHarness).close())

  test('is the vendor of the bound provider, not a constant', async () => {
    const h = await otherHarness
    const who = await signedIn(h)
    const res = await send(h, 'GET', `${who.base}/providers/status`, undefined, who.auth)
    expect(await res.json()).toEqual({ hosted: true, vendor: 'Other' })
  })

  test('another guild session gets 404 and no session gets 401', async () => {
    const first = await signedIn()
    const second = await signedIn()
    const cross = await send(
      harness,
      'GET',
      `${first.base}/providers/status`,
      undefined,
      second.auth
    )
    expect(cross.status).toBe(404)
    expect((await send(harness, 'GET', `${first.base}/providers/status`)).status).toBe(401)
  })
})

describe('provider status', () => {
  const statusBody = z.object({ hosted: z.boolean(), vendor: z.string() })

  test('reports hosted when the host has not enabled subscription providers, and the vendor', async () => {
    const who = await signedIn()
    const res = await send(harness, 'GET', `${who.base}/providers/status`, undefined, who.auth)
    expect(res.status).toBe(200)
    expect(statusBody.parse(await res.json())).toEqual({ hosted: true, vendor: 'Anthropic' })
    const sub = await signedIn(subscriptionHarness)
    const res2 = await send(
      subscriptionHarness,
      'GET',
      `${sub.base}/providers/status`,
      undefined,
      sub.auth
    )
    expect(statusBody.parse(await res2.json()).hosted).toBe(false)
  })

  test('is signed-in only and never reads another guild', async () => {
    const who = await signedIn()
    const anon = await send(harness, 'GET', `${who.base}/providers/status`)
    expect(anon.status).toBe(401)
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [
        `/guilds/${target}/providers/status`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) => devHarness.adapters.config.history(guildId, { limit: 100 }),
    })
  })
})

describe('guild config over HTTP', () => {
  test('a founded guild has the Steward, Heralds Hall with Captain and Members, and three locked Halls', async () => {
    const who = await signedIn()
    const { version, config } = await who.current()
    expect(version).toBe(1)
    expect(config).toEqual(defaultConfig())
    const roster = rosterBody.parse(
      await (await send(harness, 'GET', `${who.base}/roster?limit=2`, undefined, who.auth)).json()
    )
    expect(roster.steward.id).toBe('steward')
    expect(roster.halls).toHaveLength(2)
    expect(roster.next).not.toBeNull()
    const heralds = roster.halls.find((h) => h.id === 'heralds')
    expect(heralds?.captain).not.toBeNull()
    expect(heralds?.members.length).toBeGreaterThan(0)
    const rest = rosterBody.parse(
      await (
        await send(
          harness,
          'GET',
          `${who.base}/roster?limit=2&after=${roster.next}`,
          undefined,
          who.auth
        )
      ).json()
    )
    expect(rest.next).toBeNull()
    expect([...roster.halls, ...rest.halls].filter((h) => h.locked)).toHaveLength(3)
  })

  test('seeding is chained: the founding transaction wrote a config event and the chain verifies', async () => {
    const founded = foundedBody.parse(
      await (await send(devHarness, 'POST', '/guilds', { name: 'Pinned', goal: 'g' })).json()
    )
    const events = await devHarness.adapters.db.withGuild(founded.id, (tx) =>
      eventsAfter(tx, 0, 50)
    )
    // Pin everything founding writes: guild.founded first, then the identity and config events.
    expect(events.map((e) => e.type).sort()).toEqual(
      ['config.seeded', 'guild.founded', 'identity.founding_token_issued'].sort()
    )
    expect(events[0]?.type).toBe('guild.founded')
    const verify = await send(devHarness, 'GET', `/guilds/${founded.id}/audit/verify`, undefined, {
      'x-guild-id': founded.id,
    })
    expect(await verify.json()).toMatchObject({ intact: true, entries: events.length })
  })

  test('an invalid config is refused with the path of every offending field', async () => {
    const who = await signedIn()
    const base = defaultConfig()
    const bad = {
      ...base,
      halls: [{ ...base.halls[0], members: [{ id: 'Bad Id', name: 'x', rank: 'apprentice' }] }],
    }
    const res = await who.put(bad)
    expect(res.status).toBe(400)
    const body = z
      .object({
        error: z.string(),
        issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])) })),
      })
      .parse(await res.json())
    expect(body.error).toBe('invalid_config')
    expect(body.issues.map((i) => i.path.join('.'))).toContain('halls.0.members.0.id')
  })

  test('an unknown key at any level is refused with 422 naming its path, and no version is recorded', async () => {
    const who = await signedIn()
    const base = defaultConfig()
    const cases: [unknown, string][] = [
      [{ ...base, maxResearchPerQuest: 5 }, 'maxResearchPerQuest'],
      [{ ...base, caps: { ...base.caps, maxResearchPerQest: 5 } }, 'caps.maxResearchPerQest'],
      [
        {
          ...base,
          halls: base.halls.map((h, i) =>
            i === 0
              ? { ...h, members: h.members.map((m, j) => (j === 0 ? { ...m, admin: true } : m)) }
              : h
          ),
        },
        'halls.0.members.0.admin',
      ],
    ]
    for (const [config, path] of cases) {
      const res = await who.put(config)
      expect(res.status).toBe(422)
      const body = z
        .object({ error: z.string(), unknownKeys: z.array(z.string()) })
        .parse(await res.json())
      expect(body.error).toBe('unknown_config_key')
      expect(body.unknownKeys).toEqual([path])
    }
    const versions = await send(harness, 'GET', `${who.base}/config/versions`, undefined, who.auth)
    expect(JSON.stringify(await versions.json())).not.toContain('maxResearchPerQuest')
  })

  test('an unknown-key refusal lists at most 20 keys and says when it cut the list', async () => {
    const who = await signedIn()
    const extras = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`bogus${i}`, 1]))
    const config = { ...defaultConfig(), ...extras }
    const res = await who.put(config)
    expect(res.status).toBe(422)
    const body = z
      .object({ unknownKeys: z.array(z.string()), truncated: z.boolean().optional() })
      .parse(await res.json())
    expect(body.unknownKeys).toHaveLength(20)
    expect(body.truncated).toBe(true)
  })

  test('an unknown-key refusal shortens an over-long key to 64 characters and flags it', async () => {
    const who = await signedIn()
    const long = 'k'.repeat(300)
    const config = { ...defaultConfig(), caps: { ...defaultConfig().caps, [long]: 1 } }
    const res = await who.put(config)
    expect(res.status).toBe(422)
    const body = z
      .object({ unknownKeys: z.array(z.string()), truncated: z.boolean().optional() })
      .parse(await res.json())
    expect(body.unknownKeys).toEqual([`caps.${'k'.repeat(300)}`.slice(0, 63) + '…'])
    expect(body.truncated).toBe(true)
    const short = { ...defaultConfig(), bogus: 1 }
    const ok = await who.put(short)
    expect(
      z.object({ unknownKeys: z.array(z.string()) }).parse(await ok.json()).unknownKeys
    ).toEqual(['bogus'])
  })

  test('a shortened key never ends in half of a two-unit character', async () => {
    const who = await signedIn()
    // "caps." plus 57 letters puts the 63-unit cut in the middle of the first emoji.
    const long = `${'a'.repeat(57)}${'\u{1F600}'.repeat(10)}`
    const config = { ...defaultConfig(), caps: { ...defaultConfig().caps, [long]: 1 } }
    const res = await who.put(config)
    expect(res.status).toBe(422)
    const body = z.object({ unknownKeys: z.array(z.string()) }).parse(await res.json())
    const echoed = body.unknownKeys[0] ?? ''
    expect(echoed.length).toBeLessThanOrEqual(64)
    expect(echoed.endsWith('…')).toBe(true)
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(echoed)
    ).toBe(false)
  })

  test('tightening applies at once and the change is a chained event', async () => {
    const who = await signedIn()
    const tighter = { ...defaultConfig(), caps: { dailyTokens: 10, dailySpendCents: 10 } }
    const res = await who.put(tighter)
    expect(res.status).toBe(200)
    expect(outcome.parse(await res.json())).toEqual({
      version: 2,
      status: 'applied',
      change: 'tightening',
    })
    expect((await who.current()).config.caps.dailyTokens).toBe(10)
    const events = await harness.adapters.db.withGuild(who.guildId, (tx) => eventsAfter(tx, 0, 50))
    expect(events.map((e) => e.type)).toContain('config.version_proposed')
    const verify = await send(harness, 'GET', `${who.base}/audit/verify`, undefined, who.auth)
    expect(await verify.json()).toMatchObject({ intact: true })
  })

  test('saving autonomous is refused with a 400 naming seal_policy_locked', async () => {
    const who = await signedIn()
    const config = { ...defaultConfig(), sealPolicy: 'autonomous' as const }
    const res = await who.put(config)
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('seal_policy_locked')
  })

  test('a widening change is stored inactive until confirmed with a fresh re-authentication', async () => {
    const who = await signedIn()
    const looser = { ...defaultConfig(), sealPolicy: 'routine_alone' as const }
    const res = await who.put(looser)
    expect(res.status).toBe(202)
    expect(outcome.parse(await res.json()).status).toBe('pending')
    expect((await who.current()).config.sealPolicy).toBe('always')

    const confirm = `${who.base}/config/versions/2/confirm`
    expect((await send(harness, 'POST', confirm)).status).toBe(401)
    const noProof = await send(harness, 'POST', confirm, {}, who.auth)
    expect(noProof.status).toBe(403)
    expect((await who.current()).config.sealPolicy).toBe('always')

    const proof = await who.proof()
    const ok = await send(harness, 'POST', confirm, {}, { ...who.auth, 'x-reauth-proof': proof })
    expect(ok.status).toBe(200)
    expect((await who.current()).config.sealPolicy).toBe('routine_alone')
    const again = await send(
      harness,
      'POST',
      confirm,
      {},
      { ...who.auth, 'x-reauth-proof': await who.proof() }
    )
    expect(again.status).toBe(409)
  })

  test('no agent-facing route loosens Seal Policy: a dev-header caller cannot write config at all', async () => {
    const who = await signedIn()
    const looser = { ...defaultConfig(), sealPolicy: 'routine_alone' as const }
    const dev = await send(
      devHarness,
      'PUT',
      `${who.base}/config`,
      { config: looser, baseVersion: 1 },
      { 'x-guild-id': who.guildId }
    )
    expect(dev.status).toBe(401)
    const restore = await send(
      devHarness,
      'POST',
      `${who.base}/config/versions/1/restore`,
      {},
      { 'x-guild-id': who.guildId }
    )
    expect(restore.status).toBe(401)
    expect((await who.current()).config.sealPolicy).toBe('always')
  })

  test('removing a private Hall and re-adding it unlocked never applies at once', async () => {
    const who = await signedIn()
    const base = defaultConfig()
    const health = base.halls.find((h) => h.id === 'health')
    if (!health) {
      throw new Error('health Hall is seeded')
    }
    const gone = { ...base, halls: base.halls.filter((h) => h.id !== 'health') }
    const first = await who.put(gone)
    expect(first.status).toBe(202)
    const back = { ...base, halls: [...gone.halls, { ...health, locked: false }] }
    const second = await who.put(back)
    expect(second.status).toBe(202)
    expect((await who.current()).config).toEqual(base)
  })

  test('an earlier version can be restored, history is paginated, and a bad config is refused', async () => {
    const who = await signedIn()
    await who.put({ ...defaultConfig(), caps: { dailyTokens: 5, dailySpendCents: 5 } })
    const restored = await send(
      harness,
      'POST',
      `${who.base}/config/versions/1/restore`,
      {},
      who.auth
    )
    expect(restored.status).toBe(202)
    expect(outcome.parse(await restored.json())).toMatchObject({ version: 3, status: 'pending' })
    expect(
      (await send(harness, 'POST', `${who.base}/config/versions/77/restore`, {}, who.auth)).status
    ).toBe(404)

    const page = versionsBody.parse(
      await (
        await send(harness, 'GET', `${who.base}/config/versions?limit=2`, undefined, who.auth)
      ).json()
    )
    expect(page.versions.map((v) => v.version)).toEqual([3, 2])
    expect(page.next).toBe(2)
    const bad = await send(
      harness,
      'PUT',
      `${who.base}/config`,
      { config: { sealPolicy: 'never' }, baseVersion: 3 },
      who.auth
    )
    expect(bad.status).toBe(400)
    expect(
      (await send(harness, 'GET', `${who.base}/config/versions?limit=0`, undefined, who.auth))
        .status
    ).toBe(400)
  })

  test('a guild never reads or writes another guild config', async () => {
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [
        `/guilds/${target}/config`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) => devHarness.adapters.config.history(guildId, { limit: 100 }),
    })
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [
        `/guilds/${target}/roster`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) => devHarness.adapters.config.history(guildId, { limit: 100 }),
    })
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [
        `/guilds/${target}/config/versions`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) => devHarness.adapters.config.history(guildId, { limit: 100 }),
    })
  })
})
