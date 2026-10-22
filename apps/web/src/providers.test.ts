import { expect, test } from 'bun:test'
import { parseConfig } from './builder/model'
import {
  changeRouting,
  describePrivateDestination,
  loadProviderStatus,
  profilesOf,
  providersOf,
  setProviderPrivate,
  withDefaultProfile,
  withoutProfile,
  withoutProvider,
  withPrivateEligible,
  withProfile,
  withProvider,
} from './providers'

const self = { hosted: false, vendor: 'Anthropic' }
const hosted = { hosted: true, vendor: 'Anthropic' }

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

test('the vendor comes from the server, never from the provider id', () => {
  const home = describePrivateDestination(
    { id: 'home', auth: 'api_key', privateEligible: true },
    self
  )
  expect(home).toBe("Private Quests will be sent to Anthropic's API with your API key.")
  expect(home).not.toContain('home')
  expect(
    describePrivateDestination({ id: 'anthropic', auth: 'api_key', privateEligible: true }, self)
  ).toBe(home)
})

test('a provider that is not private-eligible says would be sent, not will be sent', () => {
  expect(
    describePrivateDestination({ id: 'home', auth: 'api_key', privateEligible: false }, self)
  ).toBe("Private Quests would be sent to Anthropic's API with your API key.")
  expect(
    describePrivateDestination({ id: 'home', auth: 'subscription', privateEligible: false }, self)
  ).toBe('Private Quests would be sent to Anthropic through your Claude subscription on this Mac.')
})

test('the status route is read with the session and parsed', async () => {
  const fetcher = async (url: string, init?: RequestInit) => {
    expect(url).toBe(`/api/guilds/${guild}/providers/status`)
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t1')
    return Response.json({ hosted: true, vendor: 'Anthropic' })
  }
  expect(await loadProviderStatus(sess, fetcher)).toEqual({ hosted: true, vendor: 'Anthropic' })
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
  const puts: unknown[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    seen.push(`${method} ${url}`)
    if (method === 'PUT' && typeof init?.body === 'string') {
      puts.push(JSON.parse(init.body))
    }
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
  return { seen, puts, fetcher, browser }
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

test('the save carries the version that was read, so a later change is not clobbered', async () => {
  const { puts, fetcher, browser } = fakes({
    status: 200,
    body: { version: 3, status: 'applied', change: 'tightening' },
  })
  await setProviderPrivate(sess, 'home', false, fetcher, browser)
  expect(puts[0]).toMatchObject({ baseVersion: 2 })
})

test('a stale save is rejected and nothing is confirmed', async () => {
  const { seen, fetcher, browser } = fakes({ status: 409, body: { error: 'stale' } })
  await expect(setProviderPrivate(sess, 'anthropic', true, fetcher, browser)).rejects.toMatchObject(
    { code: 'stale' }
  )
  expect(seen).toEqual([`GET ${cfg}`, `PUT ${cfg}`])
})

const empty = parseConfig({ steward: { id: 's', name: 'S' }, halls: [], sealPolicy: 'always' })

test('adding a provider and profiles keeps every other key and the order of profiles', () => {
  const withKey = withProvider(empty, { id: 'anthropic', auth: 'api_key' })
  expect(providersOf(withKey)).toEqual([
    { id: 'anthropic', auth: 'api_key', privateEligible: false },
  ])
  const one = withProfile(withKey, { id: 'main', provider: 'anthropic', tier: 'mid' })
  const two = withProfile(one, { id: 'deep', provider: 'anthropic', tier: 'deep', model: 'm' })
  expect(profilesOf(two).map((p) => p.id)).toEqual(['main', 'deep'])
  expect(two.sealPolicy).toBe('always')
  const replaced = withProfile(two, { id: 'main', provider: 'anthropic', tier: 'cheap' })
  expect(profilesOf(replaced).map((p) => [p.id, p.tier])).toEqual([
    ['main', 'cheap'],
    ['deep', 'deep'],
  ])
})

test('a provider already named cannot be added twice', () => {
  const once = withProvider(empty, { id: 'anthropic', auth: 'api_key' })
  expect(providersOf(withProvider(once, { id: 'anthropic', auth: 'subscription' }))).toHaveLength(1)
})

test('removing a provider removes the profiles that named it; removing a profile leaves the provider', () => {
  const full = withProfile(withProvider(empty, { id: 'a', auth: 'api_key' }), {
    id: 'p',
    provider: 'a',
    tier: 'mid',
  })
  expect(providersOf(withoutProfile(full, 'p'))).toHaveLength(1)
  expect(profilesOf(withoutProfile(full, 'p'))).toEqual([])
  expect(providersOf(withoutProvider(full, 'a'))).toEqual([])
  expect(profilesOf(withoutProvider(full, 'a'))).toEqual([])
})

test('making a profile the default moves it first and changes nothing else', () => {
  let c = withProvider(empty, { id: 'a', auth: 'api_key' })
  c = withProfile(c, { id: 'x', provider: 'a', tier: 'mid' })
  c = withProfile(c, { id: 'y', provider: 'a', tier: 'deep' })
  const next = withDefaultProfile(c, 'y')
  expect(profilesOf(next).map((p) => p.id)).toEqual(['y', 'x'])
  expect(withDefaultProfile(c, 'nope')).toEqual(c)
})

test('a widening routing change is saved pending, then confirmed with the passkey', async () => {
  const { seen, puts, fetcher, browser } = fakes({
    status: 202,
    body: { version: 3, status: 'pending', change: 'widening' },
  })
  const done = await changeRouting(
    sess,
    (c) =>
      withProfile(withProvider(c, { id: 'new', auth: 'api_key' }), {
        id: 'p',
        provider: 'new',
        tier: 'mid',
      }),
    fetcher,
    browser
  )
  expect(done).toBe('confirmed')
  expect(seen.at(-1)).toBe(`POST ${cfg}/versions/3/confirm`)
  expect(JSON.stringify(puts[0])).toContain('"baseVersion":2')
})

test('a narrowing routing change applies at once and never asks for the passkey', async () => {
  const { seen, fetcher, browser } = fakes({
    status: 200,
    body: { version: 3, status: 'applied', change: 'tightening' },
  })
  expect(await changeRouting(sess, (c) => withoutProvider(c, 'anthropic'), fetcher, browser)).toBe(
    'applied'
  )
  expect(seen).toEqual([`GET ${cfg}`, `PUT ${cfg}`])
})
