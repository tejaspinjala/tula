import { expect, test } from 'bun:test'
import { type PasskeyBrowser, reauthenticate, registerPasskey, signIn } from './passkeys'

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
