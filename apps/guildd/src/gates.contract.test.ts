import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

/** Member ids allowed to bar every guild; tests add the operator they sign in as. */
const operators: string[] = []
const harness = await createHarness({
  isolatedDb: true,
  devGuildHeader: true,
  app: { platformOperators: operators },
})
afterAll(async () => {
  await harness.close()
})
// A test that fails with a global bar up must not leave it up for the next one (every guild would
// be refused), so the gate is cleared after each test whatever happened.
afterEach(async () => {
  // A lift announces to every guild after its response; that must end before the next test starts.
  await harness.adapters.gates.settled()
  await harness.owner`delete from global_gate`
})

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const proofBody = z.object({ proof: z.string() })
const outcomeBody = z.object({
  barId: z.string(),
  scope: z.enum(['guild', 'global']),
  created: z.boolean(),
  revokedRuns: z.number(),
  killedSandboxes: z.number(),
})
const statusBody = z.object({ guild: z.boolean(), global: z.boolean() })

function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return harness.request(path, {
    method,
    headers: { ...json, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A founded guild with a signed-in Guild Master session that can re-authenticate. */
async function signedIn() {
  const guildId = await harness.foundGuild({ name: 'Gates', goal: 'g' })
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
  const session = await harness.adapters.identity.resolveSession(token)
  return { guildId, auth, proof, memberId: session?.memberId ?? '' }
}

const lease = { leaseMs: 60_000, maxActive: 10 }
const post = (guildId: string) =>
  harness.adapters.quests.post(guildId, {
    jobKey: crypto.randomUUID(),
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    title: 'Brief',
    ownerId: 'heralds-member-2',
    doneCondition: 'done',
    roundLimit: 2,
  })

describe('Bar the Gates routes', () => {
  test('barring needs a session and the Guild Master; it stops the queue and kills sandboxes at once', async () => {
    const who = await signedIn()
    const g = who.guildId
    await post(g)
    await harness.adapters.sandboxes.start(g, { questId: 'q1' })
    expect((await send('POST', `/guilds/${g}/gates/bar`, {})).status).toBe(401)
    expect(await harness.adapters.quests.claim(g, lease)).not.toBeNull()

    await post(g)
    const res = await send('POST', `/guilds/${g}/gates/bar`, who.auth)
    expect(res.status).toBe(201)
    expect(outcomeBody.parse(await res.json())).toMatchObject({
      scope: 'guild',
      created: true,
      killedSandboxes: 1,
    })
    expect(await harness.adapters.quests.claim(g, lease)).toBeNull()
    expect(await harness.adapters.sandboxes.list(g)).toEqual([])
    const again = await send('POST', `/guilds/${g}/gates/bar`, who.auth)
    expect(again.status).toBe(200)
    expect(
      statusBody.parse(await (await send('GET', `/guilds/${g}/gates`, who.auth)).json())
    ).toEqual({ guild: true, global: false })
  })

  test('lifting needs passkey re-authentication; the bar holds without it', async () => {
    const who = await signedIn()
    const g = who.guildId
    await post(g)
    await send('POST', `/guilds/${g}/gates/bar`, who.auth)

    const noProof = await send('POST', `/guilds/${g}/gates/lift`, who.auth)
    expect(noProof.status).toBe(403)
    expect(await harness.adapters.quests.claim(g, lease)).toBeNull()

    const lifted = await send('POST', `/guilds/${g}/gates/lift`, {
      ...who.auth,
      'x-reauth-proof': await who.proof(),
    })
    expect(lifted.status).toBe(200)
    expect(await harness.adapters.quests.claim(g, lease)).not.toBeNull()
    const nothing = await send('POST', `/guilds/${g}/gates/lift`, {
      ...who.auth,
      'x-reauth-proof': await who.proof(),
    })
    expect(nothing.status).toBe(404)
  })

  test('bar and lift are chained events carrying ids only', async () => {
    const who = await signedIn()
    const g = who.guildId
    await send('POST', `/guilds/${g}/gates/bar`, who.auth)
    await send('POST', `/guilds/${g}/gates/lift`, {
      ...who.auth,
      'x-reauth-proof': await who.proof(),
    })
    const events = await harness.owner`
      select type, payload from events where guild_id = ${g} and type like 'gates.%' order by seq`
    expect(events.map((e) => e.type)).toEqual(['gates.barred', 'gates.lifted'])
    for (const e of events) {
      expect(Object.keys(e.payload ?? {}).sort()).toEqual(['barId', 'memberId', 'scope'])
    }
  })

  test('a global bar stops every guild, and lifting it needs re-authentication', async () => {
    const a = await signedIn()
    const b = await signedIn()
    operators.push(a.memberId)
    await post(b.guildId)
    try {
      const res = await send('POST', '/gates/bar', a.auth)
      expect(res.status).toBe(201)
      expect(outcomeBody.parse(await res.json()).scope).toBe('global')
      expect(await harness.adapters.quests.claim(b.guildId, lease)).toBeNull()
      expect(
        statusBody.parse(await (await send('GET', `/guilds/${b.guildId}/gates`, b.auth)).json())
      ).toEqual({ guild: false, global: true })
      expect((await send('POST', '/gates/lift', a.auth)).status).toBe(403)
      expect(await harness.adapters.quests.claim(b.guildId, lease)).toBeNull()
    } finally {
      await send('POST', '/gates/lift', { ...a.auth, 'x-reauth-proof': await a.proof() })
    }
    expect(await harness.adapters.quests.claim(b.guildId, lease)).not.toBeNull()
  })

  test('a global bar answers in under 2 s with 300 guilds and refuses every one of them', async () => {
    const op = await signedIn()
    operators.push(op.memberId)
    const guilds: string[] = []
    for (let i = 0; i < 300; i += 25) {
      guilds.push(
        ...(await Promise.all(
          Array.from({ length: 25 }, () => harness.foundGuild({ name: 'Crowd', goal: 'g' }))
        ))
      )
    }
    try {
      const started = performance.now()
      const res = await send('POST', '/gates/bar', op.auth)
      const elapsed = performance.now() - started
      expect(res.status).toBe(201)
      expect(elapsed).toBeLessThan(2000)
      for (const g of guilds) {
        expect((await harness.adapters.gates.status(g)).global).toBe(true)
      }
      await harness.adapters.gates.settled()
      const [told] = await harness.owner`
        select count(distinct guild_id)::int as n from events
        where type = 'gates.barred' and guild_id = any (${guilds}::uuid[])`
      expect(told?.n).toBe(300)
    } finally {
      await send('POST', '/gates/lift', { ...op.auth, 'x-reauth-proof': await op.proof() })
      operators.splice(operators.indexOf(op.memberId), 1)
    }
  }, 120_000)

  test('only a platform operator can bar or lift every guild, not any Guild Master', async () => {
    const op = await signedIn()
    const other = await signedIn()
    operators.push(op.memberId)
    const proofOf = async (who: typeof op) => ({ ...who.auth, 'x-reauth-proof': await who.proof() })
    try {
      expect((await send('POST', '/gates/bar', other.auth)).status).toBe(403)
      expect((await send('POST', '/gates/lift', await proofOf(other))).status).toBe(403)
      const barred = await send('POST', '/gates/bar', op.auth)
      expect(barred.status).toBe(201)
      const { barId } = outcomeBody.parse(await barred.json())
      await harness.adapters.gates.settled()
      // Filtered by this bar: an earlier test's announcements may still be reaching new guilds.
      const told = await harness.owner`
        select type, payload from events
        where guild_id = ${other.guildId} and type like 'gates.%' and payload ->> 'barId' = ${barId}
        order by seq`
      expect(told.map((e) => e.type)).toEqual(['gates.barred'])
      expect(Object.keys(told[0]?.payload ?? {}).sort()).toEqual(['barId', 'scope'])
      expect((await send('POST', '/gates/lift', await proofOf(other))).status).toBe(403)
      expect(await harness.adapters.gates.status(other.guildId)).toEqual({
        guild: false,
        global: true,
      })
    } finally {
      await send('POST', '/gates/lift', await proofOf(op))
      operators.splice(operators.indexOf(op.memberId), 1)
    }
    expect(await harness.adapters.gates.status(other.guildId)).toEqual({
      guild: false,
      global: false,
    })
  }, 60_000) // reads the announcements, which take as long as there are guilds

  test('an operator listed in uppercase can still bar every guild', async () => {
    const op = await signedIn()
    operators.push(op.memberId.toUpperCase())
    try {
      expect((await send('POST', '/gates/bar', op.auth)).status).toBe(201)
    } finally {
      await send('POST', '/gates/lift', { ...op.auth, 'x-reauth-proof': await op.proof() })
      operators.splice(operators.indexOf(op.memberId.toUpperCase()), 1)
    }
  })

  test('with no platform operator configured, the global routes refuse everyone', async () => {
    const who = await signedIn()
    expect((await send('POST', '/gates/bar', who.auth)).status).toBe(403)
    expect(
      (await send('POST', '/gates/lift', { ...who.auth, 'x-reauth-proof': await who.proof() }))
        .status
    ).toBe(403)
    expect(await harness.adapters.gates.status(who.guildId)).toEqual({
      guild: false,
      global: false,
    })
  })

  test("one guild's session cannot bar or lift another guild", async () => {
    const a = await signedIn()
    const b = await signedIn()
    expect((await send('POST', `/guilds/${b.guildId}/gates/bar`, a.auth)).status).toBe(404)
    expect(await harness.adapters.gates.status(b.guildId)).toEqual({ guild: false, global: false })
    await send('POST', `/guilds/${b.guildId}/gates/bar`, b.auth)
    const lift = await send('POST', `/guilds/${b.guildId}/gates/lift`, {
      ...a.auth,
      'x-reauth-proof': await a.proof(),
    })
    expect(lift.status).toBe(404)
    expect(await harness.adapters.gates.status(b.guildId)).toEqual({ guild: true, global: false })
  })
})

describe('Bar the Gates routes are guild-isolated', () => {
  test('barring another guild looks the same as barring a guild that does not exist', async () => {
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `/guilds/${target}/gates/bar`,
        { method: 'POST', headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) => harness.adapters.gates.status(guildId),
    })
  })
})
