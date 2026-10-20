import { expect, test } from 'bun:test'
import { enablePush } from './push'
import { getSeal, sealIdFromSearch } from './seals'

const guild = '11111111-1111-4111-8111-111111111111'
const sealId = '22222222-2222-4222-8222-222222222222'
const session = { token: 't1', guildId: guild }

// 65 bytes starting 0x04, base64url: the shape of a VAPID public key.
const vapidKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url')

function fakes(keyStatus = 200) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      auth: new Headers(init?.headers).get('authorization'),
    })
    if (url.endsWith('/push/key')) {
      return Response.json({ publicKey: vapidKey }, { status: keyStatus })
    }
    return Response.json({ endpoint: 'https://push.example/phone' }, { status: 201 })
  }
  const subscribed: Uint8Array[] = []
  const push = {
    subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      subscribed.push(options.applicationServerKey)
      return {
        toJSON: () => ({
          endpoint: 'https://push.example/phone',
          expirationTime: null,
          keys: { p256dh: 'pk', auth: 'ak' },
        }),
      }
    },
  }
  return { calls, fetcher, push, subscribed }
}

test('enabling push subscribes this device with the server key and registers it', async () => {
  const { calls, fetcher, push, subscribed } = fakes()
  const result = await enablePush(session, { fetcher, push, permission: async () => 'granted' })
  expect(result).toBe('enabled')
  expect(Buffer.from(subscribed[0] ?? []).toString('base64url')).toBe(vapidKey)
  const register = calls.at(-1)
  expect(register?.url).toBe(`/api/guilds/${guild}/push/subscriptions`)
  expect(register?.method).toBe('POST')
  expect(register?.auth).toBe('Bearer t1')
  expect(register?.body).toEqual({
    endpoint: 'https://push.example/phone',
    keys: { p256dh: 'pk', auth: 'ak' },
  })
})

test('a refused notification permission subscribes nothing', async () => {
  const { calls, fetcher, push, subscribed } = fakes()
  expect(await enablePush(session, { fetcher, push, permission: async () => 'denied' })).toBe(
    'denied'
  )
  expect(subscribed).toEqual([])
  expect(calls).toEqual([])
})

test('a server without push configured leaves push unavailable', async () => {
  const { fetcher, push, subscribed } = fakes(404)
  expect(await enablePush(session, { fetcher, push, permission: async () => 'granted' })).toBe(
    'unavailable'
  )
  expect(subscribed).toEqual([])
})

test('the notification deep link names a Seal by id and nothing else', () => {
  expect(sealIdFromSearch(`?seal=${sealId}`)).toBe(sealId)
  expect(sealIdFromSearch('')).toBeNull()
  expect(sealIdFromSearch('?seal=not-a-uuid')).toBeNull()
  expect(sealIdFromSearch(`?seal=${sealId}&x=1`)).toBe(sealId)
})

test('a deep-linked Seal is fetched by id with the session', async () => {
  const seen: string[] = []
  const fetcher = async (url: string) => {
    seen.push(url)
    return Response.json({
      id: sealId,
      questId: '33333333-3333-4333-8333-333333333333',
      requestedBy: 'herald-1',
      kind: 'post',
      text: 'Ship it',
      evidence: 'verdict: pass',
      actionHash: 'a'.repeat(64),
      stale: false,
      status: 'requested',
      requestedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-04T00:00:00.000Z',
      decidedAt: null,
      decisionNote: null,
    })
  }
  const seal = await getSeal(session, sealId, fetcher)
  expect(seal.text).toBe('Ship it')
  expect(seen).toEqual([`/api/guilds/${guild}/seals/${sealId}`])
})
