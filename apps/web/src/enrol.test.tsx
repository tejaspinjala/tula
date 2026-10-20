import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { enrolPasskey, enrolTokenFromHash, passkeyLine, takeEnrolToken } from './passkeys'

const guild = '11111111-1111-4111-8111-111111111111'
const token = `${guild}.c2VjcmV0LXNlY3JldC1zZWNyZXQ`

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { SignInPanel } = await import('./SignInPanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('the enrol token is read from the fragment only', () => {
  expect(enrolTokenFromHash(`#enrol=${token}`)).toBe(token)
  expect(enrolTokenFromHash('#enrol=')).toBeNull()
  expect(enrolTokenFromHash('#enrol=not-a-token')).toBeNull()
  expect(enrolTokenFromHash(`?enrol=${token}`)).toBeNull()
  expect(enrolTokenFromHash('')).toBeNull()
})

test('taking the token clears it from the address bar', () => {
  const calls: Array<{ url: string }> = []
  const place = {
    location: { hash: `#enrol=${token}`, pathname: '/', search: '' },
    history: { replaceState: (_s: unknown, _t: string, url: string) => calls.push({ url }) },
  }
  expect(takeEnrolToken(place)).toBe(token)
  expect(calls).toEqual([{ url: '/' }])
  expect(JSON.stringify(calls)).not.toContain(token)
  const plain = { ...place, location: { hash: '', pathname: '/', search: '' } }
  expect(takeEnrolToken(plain)).toBeNull()
})

function world(options: { refuse?: boolean } = {}) {
  const seen: Array<{ url: string; enrolHeader: string | null }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, enrolHeader: new Headers(init?.headers).get('x-enrol-token') })
    if (options.refuse) {
      return Response.json({ error: 'registration_closed' }, { status: 401 })
    }
    if (url.endsWith('/enrol/begin')) {
      return Response.json({ challengeId: 'c1', options: { challenge: 'abc' } })
    }
    return Response.json({ guildId: guild }, { status: 201 })
  }
  const browser = {
    create: async () => ({ created: true }),
    get: async () => ({ signed: true }),
  }
  return { seen, fetcher, browser }
}

test('enrolling runs begin with the token header, the ceremony, then finish in cookie mode', async () => {
  const w = world()
  const session = await enrolPasskey(token, w.fetcher, w.browser)
  expect(session).toEqual({ token: '', guildId: guild })
  expect(w.seen.map((s) => s.url)).toEqual([
    `/api/guilds/${guild}/enrol/begin`,
    `/api/guilds/${guild}/enrol/finish`,
  ])
  expect(w.seen[0]?.enrolHeader).toBe(token)
  expect(w.seen[1]?.enrolHeader).toBeNull()
})

test('every failure kind has an enrol line', () => {
  for (const kind of [
    'cancelled',
    'no_credential',
    'wrong_address',
    'refused',
    'busy',
    'unknown',
  ] as const) {
    expect(passkeyLine(kind, 'enrol').length).toBeGreaterThan(0)
  }
})

async function mount(w: ReturnType<typeof world>, onSession: (s: unknown) => void) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <SignInPanel
        fetcher={w.fetcher}
        browser={w.browser}
        enrolToken={token}
        onSession={onSession}
      />
    )
  })
  return host
}

function button(host: HTMLElement, name: string) {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(name))
}

test('with a link the title screen offers to enrol and signs in on success', async () => {
  const w = world()
  const sessions: unknown[] = []
  const host = await mount(w, (s) => sessions.push(s))
  const join = button(host, 'Join')
  expect(join).toBeTruthy()
  await act(async () => {
    join?.click()
  })
  expect(sessions).toEqual([{ token: '', guildId: guild }])
})

test('a refused link shows a pixel line and never the token', async () => {
  const w = world({ refuse: true })
  const host = await mount(w, () => {})
  await act(async () => {
    button(host, 'Join')?.click()
  })
  const alert = host.querySelector('[role="alert"]')
  expect(alert?.textContent).toBe(passkeyLine('refused', 'enrol'))
  expect(host.textContent).not.toContain(token)
})
