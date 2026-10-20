import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DEFAULT_TREASURY, defaultConfig } from './guild-config'
import { TOOL_CATALOG } from './mcp/tools'
import { MAX_TREASURY_PAGE } from './ports/treasury-store'
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
const balances = z.object({ operating: z.number(), reserve: z.number(), profit: z.number() })
const overview = z.object({
  mode: z.literal('paper'),
  balances,
  spentTodayCents: z.number(),
  limits: z.object({ dailyCapCents: z.number(), treasurerLimitCents: z.number() }),
})
const spendBody = z.object({
  id: z.string(),
  status: z.string(),
  escalation: z.string().nullable(),
})
const pageBody = z.object({
  items: z.array(z.record(z.string(), z.unknown())),
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
  const guildId = await harness.foundGuild({ name: 'Treasury', goal: 'g' })
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
  return { guildId, auth, proof }
}

async function view(guildId: string, auth: Record<string, string>) {
  return overview.parse(await (await send('GET', `/guilds/${guildId}/treasury`, auth)).json())
}

describe('Treasury routes', () => {
  test('a new guild shows a $100 paper Treasury with its limits', async () => {
    const { guildId, auth } = await signedIn()
    const v = await view(guildId, auth)
    expect(v).toMatchObject({
      mode: 'paper',
      balances: { operating: 7000, reserve: 3000, profit: 0 },
      limits: { dailyCapCents: 1000, treasurerLimitCents: 500 },
    })
  })

  test('writes need a real session: the dev guild header and no credential both fail', async () => {
    const { guildId } = await signedIn()
    const dev = { 'x-guild-id': guildId }
    for (const [path, body] of [
      ['revenue', { key: 'k', amountCents: 100, evidence: 'e' }],
      ['spends', { key: 'k', amountCents: 100, purpose: 'p' }],
      ['reserve/release', { key: 'k', amountCents: 100 }],
    ] as const) {
      expect((await send('POST', `/guilds/${guildId}/treasury/${path}`, dev, body)).status).toBe(
        401
      )
      expect((await send('POST', `/guilds/${guildId}/treasury/${path}`, {}, body)).status).toBe(401)
    }
    expect((await view(guildId, dev)).balances.operating).toBe(7000)
  })

  test('revenue needs evidence; with it, 40% is reinvested and the rest is profit', async () => {
    const { guildId, auth } = await signedIn()
    const path = `/guilds/${guildId}/treasury/revenue`
    const bare = await send('POST', path, auth, { key: 'r1', amountCents: 1000, evidence: '  ' })
    expect(bare.status).toBe(422)
    expect(await bare.json()).toEqual({ error: 'evidence_required' })
    expect((await send('POST', path, auth, { key: 'r1', amountCents: 1000 })).status).toBe(400)
    const ok = await send('POST', path, auth, { key: 'r1', amountCents: 1000, evidence: 'inv-1' })
    expect(ok.status).toBe(201)
    expect((await view(guildId, auth)).balances).toEqual({
      operating: 7400,
      reserve: 3000,
      profit: 600,
    })
  })

  test('a spend over $5 waits; approving it needs re-authentication, single use', async () => {
    const who = await signedIn()
    const g = who.guildId
    const made = await send('POST', `/guilds/${g}/treasury/spends`, who.auth, {
      key: 'big',
      amountCents: 600,
      purpose: 'conference',
    })
    expect(made.status).toBe(201)
    const spend = spendBody.parse(await made.json())
    expect(spend).toMatchObject({ status: 'pending_approval', escalation: 'over_treasurer_limit' })
    const approve = `/guilds/${g}/treasury/spends/${spend.id}/approve`
    const denied = await send('POST', approve, who.auth)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'reauth_required' })
    expect((await view(g, who.auth)).balances.operating).toBe(7000)
    const proof = await who.proof()
    const done = await send('POST', approve, { ...who.auth, 'x-reauth-proof': proof })
    expect(done.status).toBe(200)
    expect(spendBody.parse(await done.json()).status).toBe('reserved')
    expect((await view(g, who.auth)).balances.operating).toBe(6400)
    expect((await send('POST', approve, { ...who.auth, 'x-reauth-proof': proof })).status).toBe(403)
  })

  test('a spend within $5 is reserved by the Treasurer, then settles for less', async () => {
    const who = await signedIn()
    const g = who.guildId
    const made = await send('POST', `/guilds/${g}/treasury/spends`, who.auth, {
      key: 'small',
      amountCents: 500,
      purpose: 'ads',
    })
    const spend = spendBody.parse(await made.json())
    expect(spend.status).toBe('reserved')
    const settled = await send(
      'POST',
      `/guilds/${g}/treasury/spends/${spend.id}/settle`,
      who.auth,
      {
        actualCents: 350,
      }
    )
    expect(settled.status).toBe(200)
    const v = await view(g, who.auth)
    expect(v.balances.operating).toBe(6650)
    expect(v.spentTodayCents).toBe(350)
    const again = await send('POST', `/guilds/${g}/treasury/spends`, who.auth, {
      key: 'small',
      amountCents: 500,
      purpose: 'ads',
    })
    expect(again.status).toBe(200)
  })

  test('releasing the reserve is the Guild Master alone, behind re-authentication', async () => {
    const who = await signedIn()
    const g = who.guildId
    const path = `/guilds/${g}/treasury/reserve/release`
    const body = { key: 'rr', amountCents: 1000 }
    expect((await send('POST', path, who.auth, body)).status).toBe(403)
    const res = await send('POST', path, { ...who.auth, 'x-reauth-proof': await who.proof() }, body)
    expect(res.status).toBe(201)
    expect((await view(g, who.auth)).balances).toEqual({
      operating: 8000,
      reserve: 2000,
      profit: 0,
    })
  })

  test('envelope limits come from guild config: a tightened cap sends a small spend to the Guild Master', async () => {
    const who = await signedIn()
    const g = who.guildId
    const { config } = await harness.adapters.config.current(g)
    const proposed = await harness.adapters.config.propose(g, {
      ...config,
      treasury: { ...DEFAULT_TREASURY, dailyCapCents: 100 },
    })
    expect(proposed.status).toBe('applied')
    const made = await send('POST', `/guilds/${g}/treasury/spends`, who.auth, {
      key: 'k',
      amountCents: 200,
      purpose: 'p',
    })
    expect(spendBody.parse(await made.json())).toMatchObject({ escalation: 'daily_cap' })
    expect((await view(g, who.auth)).limits.dailyCapCents).toBe(100)
    const widening = await harness.adapters.config.propose(g, {
      ...defaultConfig(),
      treasury: { ...DEFAULT_TREASURY, dailyCapCents: 5000 },
    })
    expect(widening.status).toBe('pending')
  })

  test('paper mode calls no payment provider: no outbound fetch in a full flow', async () => {
    const who = await signedIn()
    const g = who.guildId
    const realFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input))
        throw new Error('outbound fetch in paper mode')
      },
      { preconnect: realFetch.preconnect }
    )
    try {
      await send('POST', `/guilds/${g}/treasury/revenue`, who.auth, {
        key: 'r',
        amountCents: 500,
        evidence: 'inv',
      })
      const made = await send('POST', `/guilds/${g}/treasury/spends`, who.auth, {
        key: 's',
        amountCents: 400,
        purpose: 'p',
      })
      const spend = spendBody.parse(await made.json())
      await send('POST', `/guilds/${g}/treasury/spends/${spend.id}/settle`, who.auth, {
        actualCents: 400,
      })
      await send('GET', `/guilds/${g}/treasury/verify`, who.auth)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls).toEqual([])
  })

  test('the ledger lists in pages, and its hash chain verifies', async () => {
    const who = await signedIn()
    const g = who.guildId
    const first = pageBody.parse(
      await (await send('GET', `/guilds/${g}/treasury/entries?limit=1`, who.auth)).json()
    )
    expect(first.items).toHaveLength(1)
    expect(first.next).not.toBeNull()
    const bad = await send(
      'GET',
      `/guilds/${g}/treasury/entries?limit=${MAX_TREASURY_PAGE + 1}`,
      who.auth
    )
    expect(bad.status).toBe(400)
    const verdict = await send('GET', `/guilds/${g}/treasury/verify`, who.auth)
    expect(await verdict.json()).toEqual({ intact: true, entries: 2 })
    expect((await send('GET', `/guilds/${g}/treasury/spends`, who.auth)).status).toBe(200)
  })
})

describe('no agent-facing tool can change a balance', () => {
  test('the MCP tool catalogue has no Treasury, ledger, spend or revenue tool', () => {
    for (const tool of TOOL_CATALOG) {
      expect(`${tool.name} ${tool.description}`).not.toMatch(
        /treasur|ledger|spend|revenue|balance|reserve|payment/i
      )
    }
  })
})

describe('Treasury routes are guild-isolated', () => {
  const dev = (caller: string) => ({ 'x-guild-id': caller })
  const read = (suffix: string) => ({
    build: (caller: string, target: string): [string, RequestInit] => [
      `/guilds/${target}/treasury${suffix}`,
      { headers: dev(caller) },
    ],
    snapshot: async (guildId: string) => {
      const res = await harness.request(`/guilds/${guildId}/treasury${suffix}`, {
        headers: dev(guildId),
      })
      return res.json()
    },
  })

  test('overview, entries, spends and verify do not cross guilds', async () => {
    for (const suffix of ['', '/entries', '/spends', '/verify']) {
      await expectGuildIsolation(harness, read(suffix))
    }
  })

  test('writes aimed at another guild fail and change nothing', async () => {
    const a = await signedIn()
    const b = await signedIn()
    for (const [path, body] of [
      ['revenue', { key: 'k', amountCents: 100, evidence: 'e' }],
      ['spends', { key: 'k', amountCents: 100, purpose: 'p' }],
    ] as const) {
      const res = await send('POST', `/guilds/${b.guildId}/treasury/${path}`, a.auth, body)
      expect(res.status).toBe(404)
    }
    expect((await view(b.guildId, b.auth)).balances).toEqual({
      operating: 7000,
      reserve: 3000,
      profit: 0,
    })
  })
})
