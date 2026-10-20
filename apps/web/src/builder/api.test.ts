import { expect, test } from 'bun:test'
import { PasskeyRequestError } from '../passkeys'
import { confirmVersion, loadCurrent, restoreVersion, SaveRejected, saveConfig } from './api'
import { moveMember, parseConfig } from './model'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const options = { challenge: 'abc' }
const document = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    {
      id: 'a',
      name: 'A',
      kind: 'work',
      locked: false,
      privateEligible: false,
      captain: null,
      members: [{ id: 'm1', name: 'M', rank: 'apprentice' }],
    },
    {
      id: 'b',
      name: 'B',
      kind: 'work',
      locked: false,
      privateEligible: false,
      captain: null,
      members: [],
    },
  ],
  sealPolicy: 'always',
}

interface Seen {
  url: string
  method: string
  body: unknown
  headers: Headers
}

function fakes(replies: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    const text = typeof init?.body === 'string' ? init.body : null
    seen.push({
      url,
      method: init?.method ?? 'GET',
      body: text === null ? null : JSON.parse(text),
      headers: new Headers(init?.headers),
    })
    const reply = replies[`${init?.method ?? 'GET'} ${url}`] ?? { status: 404, body: {} }
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  return { seen, fetcher, browser }
}

const cfg = `/api/guilds/${guild}/config`

test('loading the current config returns its version and a parsed document', async () => {
  const { fetcher } = fakes({ [`GET ${cfg}`]: { body: { version: 3, config: document } } })
  const current = await loadCurrent(session, fetcher)
  expect(current.version).toBe(3)
  expect(current.config.halls).toHaveLength(2)
})

test('a canvas edit becomes the PUT body: the whole edited document, unchanged keys intact', async () => {
  const { seen, fetcher } = fakes({
    [`PUT ${cfg}`]: { body: { version: 4, status: 'applied', change: 'neutral' } },
  })
  const edited = moveMember(parseConfig(document), 'm1', { hallId: 'b' })
  const outcome = await saveConfig(session, edited, fetcher)
  expect(outcome).toEqual({ version: 4, status: 'applied', change: 'neutral' })
  expect(seen[0]?.method).toBe('PUT')
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer t1')
  expect(seen[0]?.body).toEqual({
    config: {
      ...document,
      halls: [
        { ...document.halls[0], members: [] },
        { ...document.halls[1], members: [document.halls[0]?.members[0]] },
      ],
    },
  })
})

test('a pending widening is reported with the server classification and needs no re-auth to save', async () => {
  const { seen, fetcher } = fakes({
    [`PUT ${cfg}`]: { status: 202, body: { version: 5, status: 'pending', change: 'widening' } },
  })
  const outcome = await saveConfig(session, parseConfig(document), fetcher)
  expect(outcome).toEqual({ version: 5, status: 'pending', change: 'widening' })
  expect(seen.map((s) => s.url)).toEqual([cfg])
})

test('confirming a widening runs the passkey re-auth and sends the proof', async () => {
  const { seen, fetcher, browser } = fakes({
    'POST /api/session/reauth/begin': { body: { challengeId: 'c', options } },
    'POST /api/session/reauth/finish': { body: { proof: 'proof-1' } },
    [`POST ${cfg}/versions/5/confirm`]: { body: { version: 5, status: 'applied' } },
  })
  await confirmVersion(session, 5, fetcher, browser)
  expect(seen.map((s) => s.url)).toEqual([
    '/api/session/reauth/begin',
    '/api/session/reauth/finish',
    `${cfg}/versions/5/confirm`,
  ])
  expect(seen[2]?.headers.get('x-reauth-proof')).toBe('proof-1')
})

test('a rejected config carries the issue paths so a node can show them', async () => {
  const { fetcher } = fakes({
    [`PUT ${cfg}`]: {
      status: 400,
      body: {
        error: 'invalid_config',
        issues: [{ path: ['halls', 0, 'name'], message: 'too short' }],
      },
    },
  })
  const error = await saveConfig(session, parseConfig(document), fetcher).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(SaveRejected)
  expect(error instanceof SaveRejected && error.issues).toEqual([
    { path: ['halls', 0, 'name'], message: 'too short' },
  ])
})

test('another refusal throws a request error with the server code', async () => {
  const { fetcher } = fakes({ [`PUT ${cfg}`]: { status: 409, body: { error: 'stale' } } })
  const error = await saveConfig(session, parseConfig(document), fetcher).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PasskeyRequestError)
})

test('restoring a version posts to the restore route', async () => {
  const { seen, fetcher } = fakes({
    [`POST ${cfg}/versions/2/restore`]: {
      status: 202,
      body: { version: 6, status: 'pending', change: 'widening' },
    },
  })
  expect((await restoreVersion(session, 2, fetcher)).status).toBe('pending')
  expect(seen[0]?.method).toBe('POST')
})

test('an unknown-key refusal names the offending keys in its message', async () => {
  const { fetcher } = fakes({
    [`PUT ${cfg}`]: {
      status: 422,
      body: { error: 'unknown_config_key', unknownKeys: ['caps.bogus', 'extra'] },
    },
  })
  const error = await saveConfig(session, parseConfig(document), fetcher).catch((e: unknown) => e)
  expect(error instanceof Error && error.message).toContain('caps.bogus')
  expect(error instanceof Error && error.message).toContain('extra')
})

test('a truncated unknown-key refusal still names the keys and says more were cut', async () => {
  const { fetcher } = fakes({
    [`PUT ${cfg}`]: {
      status: 422,
      body: { error: 'unknown_config_key', unknownKeys: ['caps.bogus'], truncated: true },
    },
  })
  const error = await saveConfig(session, parseConfig(document), fetcher).catch((e: unknown) => e)
  expect(error instanceof Error && error.message).toContain('caps.bogus')
  expect(error instanceof Error && error.message).toContain('and more')
})

test('an unknown-key refusal with a shortened key reads cleanly', async () => {
  const shortened = `caps.${'k'.repeat(58)}…`
  const { fetcher } = fakes({
    [`PUT ${cfg}`]: {
      status: 422,
      body: { error: 'unknown_config_key', unknownKeys: [shortened], truncated: true },
    },
  })
  const error = await saveConfig(session, parseConfig(document), fetcher).catch((e: unknown) => e)
  expect(error instanceof Error && error.message).toBe(`unknown config key: ${shortened} and more`)
})
