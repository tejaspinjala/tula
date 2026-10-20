import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const options = { challenge: 'abc' }
const realFetch = globalThis.fetch

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { App } = await import('./App')

const urls: string[] = []
let foundingIsOpen = false
let signInStatus = 200

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      urls.push(url)
      if (url === '/api/health') {
        return Response.json({ status: 'ok' })
      }
      if (url === '/api/founding') {
        return Response.json({ open: foundingIsOpen })
      }
      if (url.endsWith('/sign-in/begin')) {
        return Response.json({ challengeId: 'c1', options })
      }
      if (url.endsWith('/sign-in/finish')) {
        return signInStatus === 200
          ? Response.json({ token: 'tok', guildId: guild })
          : Response.json({ error: 'verification_failed' }, { status: signInStatus })
      }
      if (url === `/api/guilds/${guild}`) {
        return Response.json({ id: guild, name: 'Ember Guild', goal: 'Ship' })
      }
      return Response.json({ error: 'down' }, { status: 503 })
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

const browser = {
  create: async () => ({ created: true }),
  get: async () => ({ signed: true }),
}

async function mount() {
  urls.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<App browser={browser} />)
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { host, root }
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  if (!found) {
    throw new Error(`no button "${label}"`)
  }
  return found
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

const headings = (host: HTMLElement) =>
  [...host.querySelectorAll('h2')].map((h) => h.textContent?.trim())

test('signed out with founding closed shows one sign-in button and no other panel', async () => {
  foundingIsOpen = false
  const { host, root } = await mount()
  expect(button(host, 'Sign in with passkey')).toBeTruthy()
  expect(headings(host)).not.toContain('Found your guild')
  expect(host.textContent).not.toContain('Found your guild')
  for (const id of ['vault', 'roster', 'archive', 'quests', 'treasury', 'timeline', 'artifact']) {
    expect(host.querySelector(`#${id}-heading`)).toBeNull()
  }
  expect(host.querySelector('nav')).toBeNull()
  await act(async () => root.unmount())
})

test('Found your guild appears only while founding is open', async () => {
  foundingIsOpen = true
  const { host, root } = await mount()
  expect(headings(host)).toContain('Found your guild')
  await act(async () => root.unmount())
})

test('signing in with a passkey needs no guild id, then shows the guild name and id', async () => {
  foundingIsOpen = false
  signInStatus = 200
  const { host, root } = await mount()
  await click(button(host, 'Sign in with passkey'))
  expect(urls).toContain('/api/sign-in/begin')
  expect(urls).toContain('/api/sign-in/finish')
  expect(host.textContent).toContain('Ember Guild')
  expect(host.textContent).toContain(guild)
  expect(host.querySelector('#vault-heading')).not.toBeNull()
  await act(async () => root.unmount())
})

test('a refused passkey sign-in is announced', async () => {
  foundingIsOpen = false
  signInStatus = 401
  const { host, root } = await mount()
  await click(button(host, 'Sign in with passkey'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be signed in')
  expect(host.querySelector('#vault-heading')).toBeNull()
  await act(async () => root.unmount())
})

test('a guild id fallback signs in through the per-guild route', async () => {
  foundingIsOpen = false
  signInStatus = 200
  const { host, root } = await mount()
  const input = host.querySelector<HTMLInputElement>('input[name="guild-id"]')
  if (!input) {
    throw new Error('no guild id input')
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, guild)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(button(host, 'Sign in with a guild id'))
  expect(urls).toContain(`/api/guilds/${guild}/sign-in/begin`)
  expect(urls).not.toContain('/api/sign-in/begin')
  expect(host.textContent).toContain('Ember Guild')
  await act(async () => root.unmount())
})
