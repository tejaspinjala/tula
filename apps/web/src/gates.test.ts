import { expect, test } from 'bun:test'
import { barGates, describeGates, liftGates, loadGates } from './gates'
import { type PasskeyBrowser, PasskeyRequestError } from './passkeys'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const outcome = {
  barId: '22222222-2222-4222-8222-222222222222',
  scope: 'guild',
  created: true,
  revokedRuns: 2,
  killedSandboxes: 1,
}

interface Seen {
  url: string
  method: string
  headers: Headers
}

function fakes(replies: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
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

test('the gates status is read with the session token', async () => {
  const { seen, fetcher } = fakes({
    [`/api/guilds/${guild}/gates`]: { body: { guild: true, global: false } },
  })
  expect(await loadGates(session, fetcher)).toEqual({ guild: true, global: false })
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer t1')
})

test('barring one guild is a single immediate request with no re-authentication', async () => {
  const { seen, fetcher } = fakes({ [`/api/guilds/${guild}/gates/bar`]: { body: outcome } })
  const done = await barGates(session, 'guild', fetcher)
  expect(done).toMatchObject({ revokedRuns: 2, killedSandboxes: 1 })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.method).toBe('POST')
})

test('barring every guild uses the global route', async () => {
  const { seen, fetcher } = fakes({ '/api/gates/bar': { body: { ...outcome, scope: 'global' } } })
  await barGates(session, 'global', fetcher)
  expect(seen[0]?.url).toBe('/api/gates/bar')
})

test('lifting re-authenticates first and sends the proof', async () => {
  const path = `/api/guilds/${guild}/gates/lift`
  const { seen, fetcher, browser } = fakes({
    ...reauth,
    [path]: { body: { scope: 'guild', barred: false } },
  })
  await liftGates(session, 'guild', fetcher, browser)
  expect(seen.at(-1)?.url).toBe(path)
  expect(seen.at(-1)?.headers.get('x-reauth-proof')).toBe('p1')
})

test('a refused bar surfaces the server error code', async () => {
  const { fetcher } = fakes({
    [`/api/guilds/${guild}/gates/bar`]: { status: 403, body: { error: 'forbidden' } },
  })
  const failure = await barGates(session, 'guild', fetcher).catch((e: unknown) => e)
  expect(failure).toBeInstanceOf(PasskeyRequestError)
  expect(failure).toMatchObject({ code: 'forbidden' })
})

test('the status reads as a plain sentence', () => {
  expect(describeGates({ guild: false, global: false })).toBe('The Gates are open.')
  expect(describeGates({ guild: true, global: false })).toBe('The Gates are barred for this guild.')
  expect(describeGates({ guild: false, global: true })).toBe(
    'The Gates are barred for every guild.'
  )
})
