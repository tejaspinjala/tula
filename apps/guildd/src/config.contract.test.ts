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
    const res = await send(
      harness,
      'PUT',
      `${who.base}/config`,
      { config: withSubscription() },
      who.auth
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'subscription_disabled' })
    expect((await who.current()).version).toBe(1)
  })

  test('are accepted once the host enables them', async () => {
    const who = await signedIn(subscriptionHarness)
    const res = await send(
      subscriptionHarness,
      'PUT',
      `${who.base}/config`,
      { config: withSubscription() },
      who.auth
    )
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
    const res = await send(harness, 'PUT', `${who.base}/config`, { config: bad }, who.auth)
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
      const res = await send(harness, 'PUT', `${who.base}/config`, { config }, who.auth)
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

  test('tightening applies at once and the change is a chained event', async () => {
    const who = await signedIn()
    const tighter = { ...defaultConfig(), caps: { dailyTokens: 10, dailySpendCents: 10 } }
    const res = await send(harness, 'PUT', `${who.base}/config`, { config: tighter }, who.auth)
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

  test('a widening change is stored inactive until confirmed with a fresh re-authentication', async () => {
    const who = await signedIn()
    const looser = { ...defaultConfig(), sealPolicy: 'autonomous' as const }
    const res = await send(harness, 'PUT', `${who.base}/config`, { config: looser }, who.auth)
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
    expect((await who.current()).config.sealPolicy).toBe('autonomous')
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
    const looser = { ...defaultConfig(), sealPolicy: 'autonomous' as const }
    const dev = await send(
      devHarness,
      'PUT',
      `${who.base}/config`,
      { config: looser },
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
    const first = await send(harness, 'PUT', `${who.base}/config`, { config: gone }, who.auth)
    expect(first.status).toBe(202)
    const back = { ...base, halls: [...gone.halls, { ...health, locked: false }] }
    const second = await send(harness, 'PUT', `${who.base}/config`, { config: back }, who.auth)
    expect(second.status).toBe(202)
    expect((await who.current()).config).toEqual(base)
  })

  test('an earlier version can be restored, history is paginated, and a bad config is refused', async () => {
    const who = await signedIn()
    await send(
      harness,
      'PUT',
      `${who.base}/config`,
      { config: { ...defaultConfig(), caps: { dailyTokens: 5, dailySpendCents: 5 } } },
      who.auth
    )
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
      { config: { sealPolicy: 'never' } },
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
