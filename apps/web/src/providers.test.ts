import { expect, test } from 'bun:test'
import { parseConfig } from './builder/model'
import {
  describePrivateDestination,
  providersOf,
  setProviderPrivate,
  withPrivateEligible,
} from './providers'

const self = { hosted: false }
const hosted = { hosted: true }

test('a subscription provider on this Mac names the vendor, the subscription and the Mac', () => {
  expect(
    describePrivateDestination(
      { id: 'anthropic', auth: 'subscription', privateEligible: true },
      self
    )
  ).toBe('Private Quests will be sent to Anthropic through your Claude subscription on this Mac.')
})

test('an API key provider names the vendor and the key, and does not mention this Mac', () => {
  expect(
    describePrivateDestination({ id: 'anthropic', auth: 'api_key', privateEligible: true }, self)
  ).toBe("Private Quests will be sent to Anthropic's API with your API key.")
})

test('an unknown vendor is named by its provider id, never guessed', () => {
  expect(
    describePrivateDestination({ id: 'acme', auth: 'api_key', privateEligible: false }, self)
  ).toBe("Private Quests will be sent to acme's API with your API key.")
})

test('hosted drops a subscription provider, so nothing private goes through it', () => {
  expect(
    describePrivateDestination(
      { id: 'anthropic', auth: 'subscription', privateEligible: true },
      hosted
    )
  ).toBe(
    'A subscription provider is not available on a hosted Guildhall: no Private Quest will go through it.'
  )
})

test('hosted still discloses an API key provider', () => {
  expect(
    describePrivateDestination({ id: 'anthropic', auth: 'api_key', privateEligible: true }, hosted)
  ).toBe("Private Quests will be sent to Anthropic's API with your API key.")
})

const doc = parseConfig({
  steward: { id: 's', name: 'S' },
  halls: [],
  providers: [
    { id: 'anthropic', auth: 'api_key', privateEligible: false },
    { id: 'home', auth: 'subscription', privateEligible: true },
  ],
  sealPolicy: 'always',
})

test('providersOf reads the providers and withPrivateEligible flips only the named one', () => {
  expect(providersOf(doc).map((p) => p.privateEligible)).toEqual([false, true])
  const next = withPrivateEligible(doc, 'anthropic', true)
  expect(providersOf(next).map((p) => p.privateEligible)).toEqual([true, true])
  expect(next.sealPolicy).toBe('always')
  expect(providersOf(doc)[0]?.privateEligible).toBe(false)
})

test('a config with no providers key has none', () => {
  expect(providersOf(parseConfig({ steward: { id: 's', name: 'S' }, halls: [] }))).toEqual([])
})

const guild = '11111111-1111-4111-8111-111111111111'
const cfg = `/api/guilds/${guild}/config`
const sess = { token: 't1', guildId: guild }

function fakes(putReply: { status: number; body: unknown }) {
  const seen: string[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    seen.push(`${method} ${url}`)
    const replies: Record<string, { status: number; body: unknown }> = {
      [`GET ${cfg}`]: { status: 200, body: { version: 2, config: doc } },
      [`PUT ${cfg}`]: putReply,
      'POST /api/session/reauth/begin': {
        status: 200,
        body: { challengeId: 'c', options: { challenge: 'abc' } },
      },
      'POST /api/session/reauth/finish': { status: 200, body: { proof: 'p1' } },
      [`POST ${cfg}/versions/3/confirm`]: { status: 200, body: { status: 'applied' } },
    }
    const reply = replies[`${method} ${url}`] ?? { status: 404, body: {} }
    return Response.json(reply.body, { status: reply.status })
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  return { seen, fetcher, browser }
}

test('turning private eligibility on saves, then confirms with the passkey', async () => {
  const { seen, fetcher, browser } = fakes({
    status: 202,
    body: { version: 3, status: 'pending', change: 'widening' },
  })
  const result = await setProviderPrivate(sess, 'anthropic', true, fetcher, browser)
  expect(result).toBe('confirmed')
  expect(seen).toEqual([
    `GET ${cfg}`,
    `PUT ${cfg}`,
    'POST /api/session/reauth/begin',
    'POST /api/session/reauth/finish',
    `POST ${cfg}/versions/3/confirm`,
  ])
})

test('turning private eligibility off applies at once, with no passkey', async () => {
  const { seen, fetcher, browser } = fakes({
    status: 200,
    body: { version: 3, status: 'applied', change: 'tightening' },
  })
  const result = await setProviderPrivate(sess, 'home', false, fetcher, browser)
  expect(result).toBe('applied')
  expect(seen).toEqual([`GET ${cfg}`, `PUT ${cfg}`])
})
