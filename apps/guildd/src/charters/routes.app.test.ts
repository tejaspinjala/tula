import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { eventsAfter } from '../events'
import { defaultConfig } from '../guild-config'
import { LEARNING_TO_LINKEDIN } from '../rites/templates'
import { createHarness } from '../testing/harness'
import { SoftwareAuthenticator } from '../testing/software-authenticator'
import { charterSchema, exportCharter } from './charter'
import { CHARTER_EVENT } from './events'

const harness = await createHarness({ devGuildHeader: true })
afterAll(async () => {
  await harness.close()
})

const ORIGIN = 'http://localhost:5173'

/** A founded guild with a signed-in Guild Master session, through the real identity adapter. */
async function signedIn(name: string) {
  const guildId = await harness.foundGuild({ name, goal: 'g' })
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
  return { guildId, auth: { authorization: `Bearer ${token}` } }
}

const exported = (guildId: string) =>
  harness.adapters.db.withGuild(guildId, async (tx) =>
    (await eventsAfter(tx, 0, 1000)).filter((e) => e.type === CHARTER_EVENT.exported)
  )

describe('GET /guilds/:id/charter through the composed app', () => {
  test('the signed-in Guild Master exports their own guild and the event lands in its ledger', async () => {
    const a = await signedIn('Guild A')
    const res = await harness.request(`/guilds/${a.guildId}/charter`, { headers: a.auth })
    expect(res.status).toBe(200)
    expect(charterSchema.parse(await res.json()).name).toBe('Guild A')
    expect(await exported(a.guildId)).toHaveLength(1)
  })

  test('anonymous, dev-header-only and bogus-token requests are 401 with no event', async () => {
    const a = await signedIn('Guild A')
    for (const headers of [
      {},
      { 'x-guild-id': a.guildId },
      { authorization: 'Bearer not-a-session' },
    ]) {
      const res = await harness.request(`/guilds/${a.guildId}/charter`, { headers })
      expect(res.status).toBe(401)
    }
    expect(await exported(a.guildId)).toHaveLength(0)
  })

  test('the Guild Master of A aiming at B is refused exactly as at a missing guild, and B is untouched', async () => {
    const a = await signedIn('Guild A')
    const b = await signedIn('Guild B-secret')
    const own = await harness.request(`/guilds/${a.guildId}/charter`, { headers: a.auth })
    expect(own.status).toBe(200)
    const atB = await harness.request(`/guilds/${b.guildId}/charter`, { headers: a.auth })
    const atGhost = await harness.request(`/guilds/${crypto.randomUUID()}/charter`, {
      headers: a.auth,
    })
    const body = await atB.text()
    expect(atB.status).toBe(404)
    expect(atGhost.status).toBe(404)
    expect(body).not.toContain('B-secret')
    expect(z.object({ error: z.string() }).parse(JSON.parse(body)).error).toBe('not_found')
    expect(await exported(b.guildId)).toHaveLength(0)
    expect(await exported(a.guildId)).toHaveLength(1)
  })
})

describe('POST /guilds/:id/charter/import through the composed app', () => {
  const body = (importId: string) =>
    JSON.stringify({
      charter: exportCharter({
        name: 'Source',
        config: defaultConfig(),
        rites: [{ id: 's', name: 'Imported', archivedAt: null, activeGraph: LEARNING_TO_LINKEDIN }],
        now: new Date('2030-01-01T00:00:00.000Z'),
      }),
      baseVersion: 1,
      importId,
    })
  const post = (guildId: string, headers: Record<string, string>, importId: string) =>
    harness.request(`/guilds/${guildId}/charter/import`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: body(importId),
    })
  const imported = (guildId: string) =>
    harness.adapters.db.withGuild(guildId, async (tx) =>
      (await eventsAfter(tx, 0, 1000)).filter((e) => e.type === CHARTER_EVENT.imported)
    )

  test('the Guild Master imports; the Rite is a draft that POST /runs refuses', async () => {
    const a = await signedIn('Guild A')
    const res = await post(a.guildId, a.auth, 'one')
    expect(res.status).toBe(200)
    const [riteId] = z.object({ riteIds: z.array(z.string()) }).parse(await res.json()).riteIds
    expect(await imported(a.guildId)).toHaveLength(1)
    const run = await harness.request(`/guilds/${a.guildId}/rites/${riteId}/runs`, {
      method: 'POST',
      headers: { ...a.auth, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(run.status).toBeGreaterThanOrEqual(400)
    expect(z.object({ error: z.string() }).parse(await run.json()).error).toBe('no_active_version')
  })

  test('anonymous, dev-header-only and bogus-token requests are 401 and import nothing', async () => {
    const a = await signedIn('Guild A')
    for (const headers of [
      {},
      { 'x-guild-id': a.guildId },
      { authorization: 'Bearer not-a-session' },
    ]) {
      expect((await post(a.guildId, headers, 'anon')).status).toBe(401)
    }
    expect(await imported(a.guildId)).toHaveLength(0)
  })

  test('the Guild Master of A aiming at B is refused as at a missing guild and B is untouched', async () => {
    const a = await signedIn('Guild A')
    const b = await signedIn('Guild B-secret')
    const atB = await post(b.guildId, a.auth, 'x')
    const atGhost = await post(crypto.randomUUID(), a.auth, 'x')
    expect(atB.status).toBe(404)
    expect(atGhost.status).toBe(404)
    expect(await atB.text()).not.toContain('B-secret')
    expect(await imported(b.guildId)).toHaveLength(0)
  })
})

describe('POST /guilds/:id/charter/preview through the composed app', () => {
  const post = (guildId: string, headers: Record<string, string>) =>
    harness.request(`/guilds/${guildId}/charter/preview`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        charter: exportCharter({
          name: 'Source',
          config: defaultConfig(),
          rites: [],
          now: new Date('2030-01-01T00:00:00.000Z'),
        }),
      }),
    })

  test('the Guild Master previews their own guild', async () => {
    const a = await signedIn('Guild A')
    const res = await post(a.guildId, a.auth)
    expect(res.status).toBe(200)
    expect(z.object({ change: z.string() }).parse(await res.json()).change).toBe('unchanged')
  })

  test('anonymous, dev-header-only and bogus-token requests are 401', async () => {
    const a = await signedIn('Guild A')
    for (const headers of [
      {},
      { 'x-guild-id': a.guildId },
      { authorization: 'Bearer not-a-session' },
    ]) {
      expect((await post(a.guildId, headers)).status).toBe(401)
    }
  })

  test('the Guild Master of A aiming at B is refused as at a missing guild', async () => {
    const a = await signedIn('Guild A')
    const b = await signedIn('Guild B-secret')
    const atB = await post(b.guildId, a.auth)
    const atGhost = await post(crypto.randomUUID(), a.auth)
    expect(atB.status).toBe(404)
    expect(atGhost.status).toBe(404)
    expect(await atB.text()).not.toContain('B-secret')
  })
})

describe('export then import round trip through the composed app', () => {
  test('a guild export imports into a guild with the same Hall ids as 200', async () => {
    const a = await signedIn('Guild A')
    const b = await signedIn('Guild B')
    await harness.adapters.rites.save(a.guildId, 'live', {
      name: 'Live',
      graph: LEARNING_TO_LINKEDIN,
    })
    await harness.adapters.rites.publish(a.guildId, 'live', 1, null)
    await harness.adapters.rites.confirm(a.guildId, 'live', 1)
    const out = await harness.request(`/guilds/${a.guildId}/charter`, { headers: a.auth })
    expect(out.status).toBe(200)
    const charter = charterSchema.parse(await out.json())
    const { version } = await harness.adapters.config.current(b.guildId)
    const res = await harness.request(`/guilds/${b.guildId}/charter/import`, {
      method: 'POST',
      headers: { ...b.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ charter, baseVersion: version, importId: 'round-trip' }),
    })
    expect(res.status).toBe(200)
  })
})
