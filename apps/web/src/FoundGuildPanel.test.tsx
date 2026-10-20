import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Session } from './passkeys'

const guild = '11111111-1111-4111-8111-111111111111'
const options = { challenge: 'abc' }

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { FoundGuildPanel } = await import('./FoundGuildPanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

interface Call {
  url: string
  foundingHeader: string | null
}

interface Script {
  founding?: Response
  begin?: Response
  createError?: Error
}

function world(script: Script = {}) {
  const calls: Call[] = []
  const sessions: Session[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, foundingHeader: new Headers(init?.headers).get('x-founding-token') })
    if (url === '/api/guilds') {
      return (
        script.founding ?? Response.json({ id: guild, foundingToken: 'ft-secret' }, { status: 201 })
      )
    }
    if (url.endsWith('/passkeys/begin')) {
      return script.begin ?? Response.json({ challengeId: 'c1', options })
    }
    if (url.endsWith('/passkeys/finish')) {
      return Response.json({}, { status: 201 })
    }
    if (url.endsWith('/sign-in/begin')) {
      return Response.json({ challengeId: 'c2', options })
    }
    return Response.json({ token: 'tok', guildId: guild })
  }
  const browser = {
    create: async () => {
      if (script.createError) {
        throw script.createError
      }
      return { created: true }
    },
    get: async () => ({ signed: true }),
  }
  return { calls, sessions, fetcher, browser }
}

async function mount(w: ReturnType<typeof world>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <FoundGuildPanel
        fetcher={w.fetcher}
        browser={w.browser}
        onSession={(s) => {
          if (s) {
            w.sessions.push(s)
          }
        }}
      />
    )
  })
  return { host, root }
}

function type(input: HTMLInputElement | null, value: string) {
  if (!input) {
    throw new Error('missing input')
  }
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function submit(host: HTMLElement, name = 'Ember', goal = 'Ship it') {
  await act(async () => {
    type(host.querySelector<HTMLInputElement>('input[name="guild-name"]'), name)
    type(host.querySelector<HTMLInputElement>('input[name="guild-goal"]'), goal)
  })
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

test('the fields are labelled', async () => {
  const { host, root } = await mount(world())
  for (const name of ['guild-name', 'guild-goal']) {
    const input = host.querySelector(`input[name="${name}"]`)
    expect(input?.id && host.querySelector(`label[for="${input.id}"]`)).toBeTruthy()
  }
  await act(async () => root.unmount())
})

test('founding posts, registers with the founding token, then signs in', async () => {
  const w = world()
  const { host, root } = await mount(w)
  await submit(host)
  expect(w.calls.map((c) => c.url)).toEqual([
    '/api/guilds',
    `/api/guilds/${guild}/passkeys/begin`,
    `/api/guilds/${guild}/passkeys/finish`,
    `/api/guilds/${guild}/sign-in/begin`,
    `/api/guilds/${guild}/sign-in/finish`,
  ])
  expect(w.calls[1]?.foundingHeader).toBe('ft-secret')
  expect(w.sessions).toEqual([{ token: 'tok', guildId: guild }])
  await act(async () => root.unmount())
})

test('the founding token never reaches storage, the url or the page', async () => {
  const w = world()
  const { host, root } = await mount(w)
  await submit(host)
  expect(JSON.stringify({ ...localStorage })).not.toContain('ft-secret')
  expect(JSON.stringify({ ...sessionStorage })).not.toContain('ft-secret')
  expect(window.location.href).not.toContain('ft-secret')
  expect(host.textContent).not.toContain('ft-secret')
  await act(async () => root.unmount())
})

test('a rate-limited founding is announced', async () => {
  const w = world({ founding: Response.json({ error: 'rate_limited' }, { status: 429 }) })
  const { host, root } = await mount(w)
  await submit(host)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Too many')
  expect(w.sessions).toEqual([])
  await act(async () => root.unmount())
})

test('a cancelled passkey is announced and retrying reuses the founding token without founding again', async () => {
  const cancel = new Error('cancelled')
  cancel.name = 'NotAllowedError'
  const w = world({ createError: cancel })
  const { host, root } = await mount(w)
  await submit(host)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('cancelled')
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(w.calls.filter((c) => c.url === '/api/guilds')).toHaveLength(1)
  expect(w.calls.filter((c) => c.foundingHeader === 'ft-secret')).toHaveLength(2)
  await act(async () => root.unmount())
})

test('a founding token that was already used is announced', async () => {
  const w = world({ begin: Response.json({ error: 'founding_token_invalid' }, { status: 401 }) })
  const { host, root } = await mount(w)
  await submit(host)
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('already been used')
  await act(async () => root.unmount())
})
