import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DEFAULT_TRIPWIRES, defaultConfig, guildConfig } from './guild-config'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: true })
afterAll(async () => {
  await harness.close()
})

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const proofBody = z.object({ proof: z.string() })
const pauseBody = z.object({ id: z.string(), hallId: z.string(), tripwire: z.string() })
const listBody = z.object({
  thresholds: z.object({
    tokenBurnMultiple: z.number(),
    gateDenialsPerHour: z.number(),
    loopRepeats: z.number(),
  }),
  pauses: z.array(pauseBody),
  next: z.number().nullable(),
})

function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return harness.request(path, {
    method,
    headers: { ...json, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A founded guild with a signed-in Guild Master session that can re-authenticate. */
async function signedIn() {
  const guildId = await harness.foundGuild({ name: 'Tripwires', goal: 'g' })
  await harness.adapters.config.seed(guildId)
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const founding = await harness.adapters.identity.issueFoundingToken(guildId)
  const reg = await harness.adapters.identity.beginRegistration(guildId, {
    foundingToken: founding.token,
  })
  await harness.adapters.identity.finishRegistration(
    guildId,
    reg.challengeId,
    await key.register(reg.options)
  )
  const sign = await harness.adapters.identity.beginSignIn(guildId)
  const { token } = await harness.adapters.identity.finishSignIn(
    guildId,
    sign.challengeId,
    await key.assert(sign.options)
  )
  const auth = { authorization: `Bearer ${token}` }
  async function proof() {
    const b = ceremony.parse(await (await send('POST', '/session/reauth/begin', auth, {})).json())
    const done = await send('POST', '/session/reauth/finish', auth, {
      challengeId: b.challengeId,
      response: await key.assert(b.options),
    })
    return proofBody.parse(await done.json()).proof
  }
  return { guildId, auth, token, proof }
}

const brief = (jobKey: string) => ({ templateId: 'herald-brief', jobKey, title: 'Brief' })
const lease = { leaseMs: 60_000, maxActive: 10 }

describe('Tripwire and Hall-pause routes', () => {
  test("the manual pause route revokes the Hall's live run tokens", async () => {
    const who = await signedIn()
    const g = who.guildId
    const { config, secrets, gateway } = harness.adapters
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
            model: 'm',
            price: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
          },
        ],
      })
    )
    if (proposed.status === 'pending') {
      await config.confirm(g, proposed.version)
    }
    await secrets.add(g, 'cloud', 'sk-route-key')
    const { quest } = await harness.adapters.quests.post(g, {
      jobKey: 'route-run',
      templateId: 'herald-brief',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Brief',
      ownerId: 'heralds-member-2',
      doneCondition: 'done',
      roundLimit: 2,
    })
    const claimed = await harness.adapters.quests.claim(g, { ...lease, questId: quest.id })
    const run = await gateway.openRun(g, {
      questId: quest.id,
      attempt: claimed?.attempts ?? 0,
      hallId: 'heralds',
      profileId: 'cloud-mid',
    })
    if (run.status !== 'started') {
      throw new Error('expected started')
    }
    await send('POST', `/guilds/${g}/halls/heralds/pause`, who.auth)
    const res = await harness.request('/gateway/complete', {
      method: 'POST',
      headers: { ...json, authorization: `Bearer ${run.token}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 }),
    })
    expect(await res.json()).toEqual({ error: 'token_revoked' })
  })

  test('a paused Hall rejects new Quests and starts no claims; resuming needs re-auth', async () => {
    const who = await signedIn()
    const g = who.guildId
    expect((await send('POST', `/guilds/${g}/quests`, who.auth, brief('before'))).status).toBe(201)

    const paused = await send('POST', `/guilds/${g}/halls/heralds/pause`, who.auth)
    expect(paused.status).toBe(201)
    expect(pauseBody.parse(await paused.json())).toMatchObject({
      hallId: 'heralds',
      tripwire: 'manual',
    })

    const rejected = await send('POST', `/guilds/${g}/quests`, who.auth, brief('during'))
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toEqual({ error: 'hall_paused' })
    expect(await harness.adapters.quests.claim(g, lease)).toBeNull()

    const noProof = await send('POST', `/guilds/${g}/halls/heralds/resume`, who.auth)
    expect(noProof.status).toBe(403)
    expect(await harness.adapters.tripwires.isPaused(g, 'heralds')).toBe(true)

    const resumed = await send('POST', `/guilds/${g}/halls/heralds/resume`, {
      ...who.auth,
      'x-reauth-proof': await who.proof(),
    })
    expect(resumed.status).toBe(200)
    expect((await send('POST', `/guilds/${g}/quests`, who.auth, brief('after'))).status).toBe(201)
    expect(await harness.adapters.quests.claim(g, lease)).not.toBeNull()
  })

  test('resuming a Hall forgives the loop count of its Quests, so the next watch does not re-pause it', async () => {
    const who = await signedIn()
    const g = who.guildId
    const made = await send('POST', `/guilds/${g}/quests`, who.auth, brief('looping'))
    const id = z.object({ id: z.string() }).parse(await made.json()).id
    await harness.adapters.quests.claim(g, { ...lease, questId: id })
    await harness.adapters.quests.fail(g, id, 1, 'timeout')
    await send('POST', `/guilds/${g}/halls/heralds/pause`, who.auth)
    await send('POST', `/guilds/${g}/halls/heralds/resume`, {
      ...who.auth,
      'x-reauth-proof': await who.proof(),
    })
    expect(await harness.adapters.quests.get(g, id)).toMatchObject({ attempts: 1, refunds: 1 })
  })

  test('pause and resume are chained events carrying ids only', async () => {
    const who = await signedIn()
    const g = who.guildId
    await send('POST', `/guilds/${g}/halls/heralds/pause`, who.auth)
    await send('POST', `/guilds/${g}/halls/heralds/resume`, {
      ...who.auth,
      'x-reauth-proof': await who.proof(),
    })
    const events = await harness.owner`
      select type, payload from events where guild_id = ${g} and type like 'hall.%' order by seq`
    expect(events.map((e) => e.type)).toEqual(['hall.paused', 'hall.resumed'])
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual(['hallId', 'pauseId', 'tripwire'])
    expect(Object.keys(events[1]?.payload ?? {}).sort()).toEqual(['hallId', 'pauseId'])
  })

  test('the pause list shows thresholds and active pauses, paginated', async () => {
    const who = await signedIn()
    const g = who.guildId
    for (const hall of ['heralds', 'health']) {
      await send('POST', `/guilds/${g}/halls/${hall}/pause`, who.auth)
    }
    const first = listBody.parse(
      await (await send('GET', `/guilds/${g}/tripwires?limit=1`, who.auth)).json()
    )
    expect(first.thresholds).toEqual(DEFAULT_TRIPWIRES)
    expect(first.pauses.map((p) => p.hallId)).toEqual(['heralds'])
    expect(first.next).not.toBeNull()
    const second = listBody.parse(
      await (
        await send('GET', `/guilds/${g}/tripwires?limit=1&after=${first.next}`, who.auth)
      ).json()
    )
    expect(second.pauses.map((p) => p.hallId)).toEqual(['health'])
    expect(second.next).toBeNull()
    expect((await send('GET', `/guilds/${g}/tripwires?limit=0`, who.auth)).status).toBe(400)
  })

  test('an unknown Hall cannot be paused; resuming a running Hall is not found', async () => {
    const who = await signedIn()
    const g = who.guildId
    expect((await send('POST', `/guilds/${g}/halls/nowhere/pause`, who.auth)).status).toBe(404)
    const resumed = await send('POST', `/guilds/${g}/halls/heralds/resume`, {
      ...who.auth,
      'x-reauth-proof': await who.proof(),
    })
    expect(resumed.status).toBe(404)
  })

  test('without a session nothing pauses or resumes', async () => {
    const who = await signedIn()
    const g = who.guildId
    expect((await send('POST', `/guilds/${g}/halls/heralds/pause`, {})).status).toBe(401)
    expect((await send('POST', `/guilds/${g}/halls/heralds/resume`, {})).status).toBe(401)
    expect((await send('GET', `/guilds/${g}/tripwires`, {})).status).toBe(401)
  })

  test('cross-guild: pausing, resuming or reading another guild looks like a missing guild', async () => {
    const a = await signedIn()
    const b = await signedIn()
    const ghost = crypto.randomUUID()
    await harness.adapters.tripwires.pause(b.guildId, {
      hallId: 'heralds',
      tripwire: 'loop',
      observed: 5,
      threshold: 5,
    })
    for (const verb of ['pause', 'resume']) {
      const headers = { ...a.auth, 'x-reauth-proof': await a.proof() }
      const atB = await send('POST', `/guilds/${b.guildId}/halls/heralds/${verb}`, headers)
      const headers2 = { ...a.auth, 'x-reauth-proof': await a.proof() }
      const atGhost = await send('POST', `/guilds/${ghost}/halls/heralds/${verb}`, headers2)
      expect(atB.status).toBe(404)
      expect(atGhost.status).toBe(404)
    }
    expect(await harness.adapters.tripwires.isPaused(b.guildId, 'heralds')).toBe(true)
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `/guilds/${target}/tripwires`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) =>
        (await harness.adapters.tripwires.list(guildId, { limit: 100 })).pauses,
    })
  })
})
