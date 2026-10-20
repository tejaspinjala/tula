import { expect, test } from 'bun:test'
import {
  fetchGuild,
  foundGuild,
  foundingOpen,
  type PasskeyBrowser,
  PasskeyRequestError,
  passkeyFailure,
  passkeyLine,
  reauthenticate,
  registerPasskey,
  signIn,
  signInWithPasskey,
  withNoPasskeyDetection,
} from './passkeys'

const guild = '11111111-1111-4111-8111-111111111111'
const options = { challenge: 'abc' }

interface Seen {
  url: string
  auth: string | null
  body: unknown
}

function fakes(replies: Record<string, unknown>) {
  const seen: Seen[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    return Response.json(replies[url] ?? {}, {
      status: url.endsWith('/passkeys/finish') ? 201 : 200,
    })
  }
  const browser: PasskeyBrowser = {
    create: async (opts) => ({ created: opts.challenge }),
    get: async (opts) => ({ signed: opts.challenge }),
  }
  return { seen, fetcher, browser }
}

test('registering a passkey runs begin, the browser ceremony, then finish', async () => {
  const { seen, fetcher, browser } = fakes({
    [`/api/guilds/${guild}/passkeys/begin`]: { challengeId: 'c1', options },
  })
  await registerPasskey(guild, undefined, fetcher, browser)
  expect(seen.map((s) => s.url)).toEqual([
    `/api/guilds/${guild}/passkeys/begin`,
    `/api/guilds/${guild}/passkeys/finish`,
  ])
  expect(seen[1]?.body).toEqual({ challengeId: 'c1', response: { created: 'abc' } })
})

test('signing in returns the session token', async () => {
  const { seen, fetcher, browser } = fakes({
    [`/api/guilds/${guild}/sign-in/begin`]: { challengeId: 'c2', options },
    [`/api/guilds/${guild}/sign-in/finish`]: { token: 't', guildId: guild },
  })
  expect(await signIn(guild, fetcher, browser)).toEqual({ token: 't', guildId: guild })
  expect(seen[1]?.body).toEqual({ challengeId: 'c2', response: { signed: 'abc' } })
})

test('re-authenticating sends the session token and returns the proof', async () => {
  const { seen, fetcher, browser } = fakes({
    '/api/session/reauth/begin': { challengeId: 'c3', options },
    '/api/session/reauth/finish': { proof: 'p' },
  })
  expect(await reauthenticate('t', fetcher, browser)).toBe('p')
  expect(seen.every((s) => s.auth === 'Bearer t')).toBe(true)
})

test('founding a guild posts name and goal and returns the id and one-time founding token', async () => {
  const { seen, fetcher } = fakes({ '/api/guilds': { id: guild, foundingToken: 'ft' } })
  expect(await foundGuild('Ember', 'Ship it', fetcher)).toEqual({ id: guild, foundingToken: 'ft' })
  expect(seen[0]?.url).toBe('/api/guilds')
  expect(seen[0]?.body).toEqual({ name: 'Ember', goal: 'Ship it' })
})

test('the first passkey sends the founding token as x-founding-token on begin only', async () => {
  const headers: Array<string | null> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get('x-founding-token'))
    return Response.json(url.endsWith('/begin') ? { challengeId: 'c1', options } : {}, {
      status: 200,
    })
  }
  const { browser } = fakes({})
  await registerPasskey(guild, undefined, fetcher, browser, 'ft')
  expect(headers).toEqual(['ft', null])
})

test('a refused founding surfaces the status so the screen can say rate limited', async () => {
  const fetcher = async () => Response.json({ error: 'rate_limited' }, { status: 429 })
  const error = await foundGuild('Ember', 'Ship it', fetcher).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PasskeyRequestError)
  expect(error instanceof PasskeyRequestError && error.status).toBe(429)
})

test('signing in with a passkey posts to /sign-in with no guild id', async () => {
  const { seen, fetcher, browser } = fakes({
    '/api/sign-in/begin': { challengeId: 'c4', options },
    '/api/sign-in/finish': { token: 't', guildId: guild },
  })
  expect(await signInWithPasskey(fetcher, browser)).toEqual({ token: 't', guildId: guild })
  expect(seen.map((s) => s.url)).toEqual(['/api/sign-in/begin', '/api/sign-in/finish'])
  expect(seen[1]?.body).toEqual({ challengeId: 'c4', response: { signed: 'abc' } })
})

test('founding is open only when guildd says so; a failed call reads as closed', async () => {
  const reply =
    (body: unknown, status = 200) =>
    async () =>
      Response.json(body, { status })
  expect(await foundingOpen(reply({ open: true }))).toBe('open')
  expect(await foundingOpen(reply({ open: false }))).toBe('closed')
  expect(await foundingOpen(reply({ error: 'x' }, 503))).toBe('closed')
  expect(await foundingOpen(reply({ unexpected: 1 }))).toBe('closed')
  expect(await foundingOpen(reply({ error: 'rate_limited' }, 429))).toBe('busy')
})

test('the signed-in guild is read with the session token', async () => {
  const auth: Array<string | null> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get('authorization'))
    expect(url).toBe(`/api/guilds/${guild}`)
    return Response.json({ id: guild, name: 'Ember', goal: 'Ship' })
  }
  expect(await fetchGuild({ token: 't', guildId: guild }, fetcher)).toEqual({
    id: guild,
    name: 'Ember',
  })
  expect(auth).toEqual(['Bearer t'])
})

function named(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

test('a passkey failure is told apart: cancel, no credential, wrong address, refusal, 429', () => {
  expect(passkeyFailure(named('NotAllowedError'))).toBe('cancelled')
  expect(passkeyFailure(named('NoPasskeyOffered'))).toBe('no_credential')
  expect(passkeyFailure(named('SecurityError'))).toBe('wrong_address')
  expect(passkeyFailure(new PasskeyRequestError(401, 'verification_failed'))).toBe('refused')
  expect(passkeyFailure(new PasskeyRequestError(429, 'rate_limited'))).toBe('busy')
  expect(passkeyFailure(new Error('boom'))).toBe('unknown')
})

test('each failure reads as its own in-world line', () => {
  const kinds = [
    'cancelled',
    'no_credential',
    'wrong_address',
    'refused',
    'busy',
    'unknown',
  ] as const
  const lines = kinds.map((kind) => passkeyLine(kind, 'sign-in'))
  expect(new Set(lines).size).toBe(kinds.length)
  expect(passkeyLine('no_credential', 'sign-in')).toContain('address')
})

test('the no-passkey line also covers a very fast real cancel', () => {
  expect(passkeyLine('no_credential', 'sign-in')).toContain('set it aside')
  expect(passkeyLine('no_credential', 'founding')).toContain('set it aside')
})

test('a browser that rejects at once with NotAllowedError offered no passkey; a slow one was cancelled', async () => {
  const reject = async () => {
    throw named('NotAllowedError')
  }
  let clock = 0
  const instant = withNoPasskeyDetection({ create: reject, get: reject }, () => clock)
  await expect(instant.get(options)).rejects.toMatchObject({ name: 'NoPasskeyOffered' })
  const slow = withNoPasskeyDetection(
    {
      create: reject,
      get: async () => {
        clock += 5000
        throw named('NotAllowedError')
      },
    },
    () => clock
  )
  await expect(slow.get(options)).rejects.toMatchObject({ name: 'NotAllowedError' })
})
