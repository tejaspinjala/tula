import { expect, test } from 'bun:test'
import { type PasskeyBrowser, PasskeyRequestError } from './passkeys'
import { decideSeal, listSeals, markPosted } from './seals'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const hash = 'a'.repeat(64)
const seal = {
  id: '22222222-2222-4222-8222-222222222222',
  questId: '33333333-3333-4333-8333-333333333333',
  requestedBy: 'herald-1',
  kind: 'post',
  text: 'Ship it',
  evidence: 'verdict: pass',
  actionHash: hash,
  status: 'requested',
  requestedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-04T00:00:00.000Z',
  decidedAt: null,
  decisionNote: null,
  reservedUntil: null,
  consumedAt: null,
}

interface Seen {
  url: string
  method: string
  headers: Headers
  body: unknown
}

function fakes(replies: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    const reply = replies[url] ?? { body: {} }
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }
  const browser: PasskeyBrowser = {
    create: async () => ({}),
    get: async (opts) => ({ signed: opts.challenge }),
  }
  return { seen, fetcher, browser }
}

const reauth = {
  '/api/session/reauth/begin': { body: { challengeId: 'c1', options: { challenge: 'abc' } } },
  '/api/session/reauth/finish': { body: { proof: 'p1' } },
}

test('the inbox lists pending Seals with their exact text and hash', async () => {
  const { seen, fetcher } = fakes({
    [`/api/guilds/${guild}/seals?status=requested&limit=20`]: {
      body: { seals: [seal], next: null },
    },
  })
  const page = await listSeals(session, fetcher)
  expect(page.seals[0]).toMatchObject({ text: 'Ship it', actionHash: hash })
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer t1')
})

test('stamping re-authenticates first, then sends the hash with the proof', async () => {
  const path = `/api/guilds/${guild}/seals/${seal.id}/approve`
  const { seen, fetcher, browser } = fakes({
    ...reauth,
    [path]: { body: { ...seal, status: 'approved' } },
  })
  const done = await decideSeal(session, seal, 'approved', undefined, fetcher, browser)
  expect(done.status).toBe('approved')
  const last = seen.at(-1)
  expect(last?.url).toBe(path)
  expect(last?.headers.get('x-reauth-proof')).toBe('p1')
  expect(last?.body).toEqual({ actionHash: hash })
})

test('denying sends the note', async () => {
  const path = `/api/guilds/${guild}/seals/${seal.id}/deny`
  const { seen, fetcher, browser } = fakes({
    ...reauth,
    [path]: { body: { ...seal, status: 'denied' } },
  })
  await decideSeal(session, seal, 'denied', 'too salesy', fetcher, browser)
  expect(seen.at(-1)?.body).toEqual({ actionHash: hash, note: 'too salesy' })
})

test('a refused stamp surfaces the server error code', async () => {
  const { fetcher, browser } = fakes({
    ...reauth,
    [`/api/guilds/${guild}/seals/${seal.id}/approve`]: {
      status: 409,
      body: { error: 'hash_mismatch' },
    },
  })
  const failure = await decideSeal(session, seal, 'approved', undefined, fetcher, browser).catch(
    (e: unknown) => e
  )
  expect(failure).toBeInstanceOf(PasskeyRequestError)
  expect(failure).toMatchObject({ code: 'hash_mismatch' })
})

test('marking posted sends the hash without a re-authentication', async () => {
  const path = `/api/guilds/${guild}/seals/${seal.id}/posted`
  const { seen, fetcher } = fakes({ [path]: { body: { ...seal, status: 'consumed' } } })
  const done = await markPosted(session, seal, fetcher)
  expect(done.status).toBe('consumed')
  expect(seen).toHaveLength(1)
  expect(seen[0]?.body).toEqual({ actionHash: hash })
})
