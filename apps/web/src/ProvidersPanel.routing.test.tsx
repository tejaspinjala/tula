import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { ProvidersPanel } = await import('./ProvidersPanel')

let config: Record<string, unknown> = {}
let putStatus = 202
let putError: string | null = null
const calls: string[] = []
const puts: Record<string, unknown>[] = []

const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.replace(`/api/guilds/${guild}`, '')}`)
      if (url.endsWith('/providers/status')) {
        return Response.json({ hosted: false, vendor: 'Anthropic' })
      }
      if (method === 'PUT') {
        puts.push(JSON.parse(String(init?.body)))
        if (putError !== null) {
          return Response.json({ error: putError }, { status: 409 })
        }
        return Response.json(
          {
            version: 3,
            status: putStatus === 202 ? 'pending' : 'applied',
            change: putStatus === 202 ? 'widening' : 'tightening',
          },
          { status: putStatus }
        )
      }
      if (url.endsWith('/session/reauth/begin')) {
        return Response.json({ challengeId: 'c', options: { challenge: 'abc' } })
      }
      if (url.endsWith('/session/reauth/finish')) {
        return Response.json({ proof: 'p1' })
      }
      if (url.endsWith('/confirm')) {
        return Response.json({ status: 'applied' })
      }
      return Response.json({ version: 2, config })
    },
    { preconnect: realFetch.preconnect }
  )
})
beforeEach(() => {
  calls.length = 0
  puts.length = 0
  putStatus = 202
  putError = null
  config = {
    steward: { id: 's', name: 'S' },
    halls: [],
    providers: [{ id: 'anthropic', auth: 'api_key', privateEligible: false }],
    routingProfiles: [
      { id: 'main', provider: 'anthropic', tier: 'mid' },
      { id: 'big', provider: 'anthropic', tier: 'deep' },
    ],
  }
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<ProvidersPanel session={session} browser={browser} />)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  return { host, unmount: () => act(async () => root.unmount()) }
}

async function fill(host: HTMLElement, name: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)
  if (!field) {
    throw new Error(`no field ${name}`)
  }
  const select = field instanceof HTMLSelectElement
  await act(async () => {
    const proto = select ? HTMLSelectElement : HTMLInputElement
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true }))
  })
}

async function press(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label
  )
  if (!button) {
    throw new Error(`no button ${label}`)
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
}

test('adding a provider saves it pending, asks for the passkey, and names the Vault secret', async () => {
  const { host, unmount } = await mount()
  expect(host.textContent).toContain('Vault')
  await fill(host, 'provider-id', 'openrouter')
  await fill(host, 'provider-kind', 'api_key')
  await press(host, 'Add provider')
  expect(puts).toHaveLength(1)
  const sent = puts[0]?.config as { providers: { id: string }[] }
  expect(sent.providers.map((p) => p.id)).toEqual(['anthropic', 'openrouter'])
  expect(puts[0]?.baseVersion).toBe(2)
  expect(calls).toContain('POST /api/session/reauth/begin')
  expect(calls).toContain('POST /config/versions/3/confirm')
  expect(JSON.stringify(puts)).not.toMatch(/sk-|apiKey|secret/i)
  await unmount()
})

test('adding a routing profile on a provider reaches the passkey confirm when it widens', async () => {
  const { host, unmount } = await mount()
  await fill(host, 'profile-id', 'cheap-one')
  await fill(host, 'profile-provider', 'anthropic')
  await fill(host, 'profile-tier', 'cheap')
  await press(host, 'Add profile')
  const sent = puts[0]?.config as { routingProfiles: { id: string }[] }
  expect(sent.routingProfiles.map((p) => p.id)).toEqual(['main', 'big', 'cheap-one'])
  expect(calls).toContain('POST /config/versions/3/confirm')
  await unmount()
})

test('removing a profile applies at once with no passkey prompt', async () => {
  putStatus = 200
  const { host, unmount } = await mount()
  await press(host, 'Remove profile big')
  const sent = puts[0]?.config as { routingProfiles: { id: string }[] }
  expect(sent.routingProfiles.map((p) => p.id)).toEqual(['main'])
  expect(calls).not.toContain('POST /api/session/reauth/begin')
  await unmount()
})

test('the first profile is marked the default and another can be made the default', async () => {
  putStatus = 200
  const { host, unmount } = await mount()
  expect(host.textContent).toContain('Default')
  await press(host, 'Make big the default profile')
  const sent = puts[0]?.config as { routingProfiles: { id: string }[] }
  expect(sent.routingProfiles.map((p) => p.id)).toEqual(['big', 'main'])
  await unmount()
})

test('a refused save says why', async () => {
  putError = 'stale'
  const { host, unmount } = await mount()
  await fill(host, 'provider-id', 'late')
  await press(host, 'Add provider')
  expect(host.textContent).toContain('stale')
  await unmount()
})
