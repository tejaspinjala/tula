import { expect, test } from 'bun:test'
import { type PasskeyBrowser, PasskeyRequestError } from './passkeys'
import { addSecret, checkSecrets, listSecrets, submitSecret } from './vault'

test('the value is cleared after a rejected add as well as a successful one', async () => {
  const { fetcher, browser } = fakes({
    '/api/session/reauth/begin': { body: { challengeId: 'c1', options: { challenge: 'abc' } } },
    '/api/session/reauth/finish': { body: { proof: 'p1' } },
    [`/api/guilds/${guild}/vault/secrets`]: { status: 409, body: { error: 'secret_exists' } },
  })
  let clears = 0
  await submitSecret(session, 'openai', 'sk-secret', fetcher, browser, () => {
    clears++
  }).catch(() => undefined)
  expect(clears).toBe(1)
})

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }

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

test('adding a secret re-authenticates first, then posts the value with the proof', async () => {
  const { seen, fetcher, browser } = fakes({
    '/api/session/reauth/begin': { body: { challengeId: 'c1', options: { challenge: 'abc' } } },
    '/api/session/reauth/finish': { body: { proof: 'p1' } },
    [`/api/guilds/${guild}/vault/secrets`]: { status: 201, body: { ref: 'openai' } },
  })
  const ref = await addSecret(session, 'openai', 'sk-secret', fetcher, browser)
  expect(ref).toBe('openai')
  const last = seen.at(-1)
  expect(last?.url).toBe(`/api/guilds/${guild}/vault/secrets`)
  expect(last?.headers.get('x-reauth-proof')).toBe('p1')
  expect(last?.headers.get('authorization')).toBe('Bearer t1')
  expect(last?.body).toEqual({ ref: 'openai', value: 'sk-secret' })
})

test('a refused add surfaces the code and never echoes the value', async () => {
  const { fetcher, browser } = fakes({
    '/api/session/reauth/begin': { body: { challengeId: 'c1', options: { challenge: 'abc' } } },
    '/api/session/reauth/finish': { body: { proof: 'p1' } },
    [`/api/guilds/${guild}/vault/secrets`]: { status: 409, body: { error: 'secret_exists' } },
  })
  const error = await addSecret(session, 'openai', 'sk-secret', fetcher, browser).catch((e) => e)
  expect(error).toBeInstanceOf(PasskeyRequestError)
  expect(String(error.message)).not.toContain('sk-secret')
  expect(error.code).toBe('secret_exists')
})

test('listing and checking return refs and statuses only', async () => {
  const { seen, fetcher } = fakes({
    [`/api/guilds/${guild}/vault/secrets?limit=50`]: { body: { refs: ['a'], next: null } },
    [`/api/guilds/${guild}/vault/check`]: {
      body: { results: [{ ref: 'a', status: 'resolved' }] },
    },
  })
  expect(await listSecrets(session, fetcher)).toEqual({ refs: ['a'], next: null })
  expect(await checkSecrets(session, ['a'], fetcher)).toEqual([{ ref: 'a', status: 'resolved' }])
  expect(seen.every((s) => s.headers.get('authorization') === 'Bearer t1')).toBe(true)
})
