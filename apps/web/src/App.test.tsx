import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const options = { challenge: 'abc' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { App } = await import('./App')

const urls: string[] = []
let foundingIsOpen = false
let foundingStatus = 200
let signInStatus = 200
/** Whether guildd holds a live cookie session for this browser (what a reload would find). */
let cookieLive = false
const requests: { url: string; method: string; headers: Headers }[] = []

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      urls.push(url)
      requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) })
      if (url === '/api/session' && !init?.method) {
        return cookieLive
          ? Response.json({ guildId: guild })
          : Response.json({ error: 'unauthenticated' }, { status: 401 })
      }
      if (url === '/api/session/logout') {
        cookieLive = false
        return new Response(null, { status: 204 })
      }
      if (url === '/api/health') {
        return Response.json({ status: 'ok' })
      }
      if (url === '/api/founding') {
        return foundingStatus === 429
          ? Response.json({ error: 'rate_limited' }, { status: 429 })
          : Response.json({ open: foundingIsOpen })
      }
      if (url.endsWith('/sign-in/begin')) {
        return Response.json({ challengeId: 'c1', options })
      }
      if (url.endsWith('/sign-in/finish')) {
        if (signInStatus === 200 && new Headers(init?.headers).get('x-session-mode') === 'cookie') {
          cookieLive = true
          return Response.json({ guildId: guild })
        }
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

/** Sets the page address, as a deep link or a tapped push link would. */
function visit(path: string) {
  window.history.pushState({}, '', path)
}

const browser = {
  create: async () => ({ created: true }),
  get: async () => ({ signed: true }),
}

async function mount(opts: { keepSession?: boolean } = {}) {
  urls.length = 0
  requests.length = 0
  if (!opts.keepSession) {
    cookieLive = false
  }
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

function option(host: HTMLElement, label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.textContent?.trim() === label
  )
  if (!found) {
    throw new Error(`no menu option "${label}"`)
  }
  return found
}

const headings = (host: HTMLElement) =>
  [...host.querySelectorAll('h2')].map((h) => h.textContent?.trim())

test('signed out with founding closed shows one sign-in button and no other panel', async () => {
  foundingIsOpen = false
  const { host, root } = await mount()
  expect(option(host, 'Continue')).toBeTruthy()
  expect(headings(host)).not.toContain('Found your guild')
  expect(host.textContent).not.toContain('Found your guild')
  for (const id of ['vault', 'roster', 'archive', 'quests', 'treasury', 'timeline', 'artifact']) {
    expect(host.querySelector(`#${id}-heading`)).toBeNull()
  }
  expect(host.querySelector('nav')).toBeNull()
  await act(async () => root.unmount())
})

test('New guild is on the title menu only while founding is open, and opens the founding form', async () => {
  foundingIsOpen = false
  const closed = await mount()
  expect(() => option(closed.host, 'New guild')).toThrow()
  await act(async () => closed.root.unmount())
  foundingIsOpen = true
  const { host, root } = await mount()
  expect(headings(host)).not.toContain('Found your guild')
  await click(option(host, 'New guild'))
  expect(headings(host)).toContain('Found your guild')
  await act(async () => root.unmount())
})

test('signing in with a passkey needs no guild id, then drops into the world with the guild name', async () => {
  foundingIsOpen = false
  signInStatus = 200
  const { host, root } = await mount()
  await click(option(host, 'Continue'))
  expect(urls).toContain('/api/sign-in/begin')
  expect(urls).toContain('/api/sign-in/finish')
  expect(host.querySelector('h1')?.textContent).toContain('Ember Guild')
  expect(host.querySelector('h1')?.textContent).not.toContain(guild)
  expect(host.querySelector('[data-testid="game-frame"]')).not.toBeNull()
  expect(host.querySelector('nav')).toBeNull()
  expect(host.querySelector('dialog[open]')).toBeNull()
  await act(async () => root.unmount())
})

test('a deep link opens its Bag page over the world, and a Seal link opens the Seals page', async () => {
  foundingIsOpen = false
  signInStatus = 200
  visit('/vault')
  const first = await mount()
  await click(option(first.host, 'Continue'))
  expect(first.host.querySelector('dialog[open] #settings-title')).not.toBeNull()
  expect(first.host.querySelector('[data-testid="game-frame"]')).not.toBeNull()
  await act(async () => first.root.unmount())

  visit('/?seal=abc')
  const second = await mount()
  await click(option(second.host, 'Continue'))
  expect(second.host.querySelector('dialog[open] #seals-title')).not.toBeNull()
  await act(async () => second.root.unmount())
  visit('/')
})

test('signed out at a deep link shows only sign-in, never the view', async () => {
  foundingIsOpen = false
  visit('/vault')
  const { host, root } = await mount()
  expect(option(host, 'Continue')).toBeTruthy()
  expect(host.querySelector('#vault-heading')).toBeNull()
  expect(host.querySelector('nav')).toBeNull()
  await act(async () => root.unmount())
  visit('/')
})

test('a refused passkey sign-in is announced', async () => {
  foundingIsOpen = false
  signInStatus = 401
  const { host, root } = await mount()
  await click(option(host, 'Continue'))
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('stayed shut')
  expect(host.querySelector('#vault-heading')).toBeNull()
  await act(async () => root.unmount())
})

test('a guild id fallback signs in through the per-guild route', async () => {
  foundingIsOpen = false
  signInStatus = 200
  const { host, root } = await mount()
  await click(option(host, 'Older passkey'))
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

test('a rate-limited /founding shows a try again shortly state instead of vanishing (B3)', async () => {
  foundingIsOpen = true
  foundingStatus = 429
  const { host, root } = await mount()
  await click(option(host, 'New guild'))
  expect(host.textContent).toContain('try again shortly')
  foundingStatus = 200
  await act(async () => root.unmount())
})

test('signed out: the title shows the wordmark and a Member explains passkeys on request', async () => {
  foundingIsOpen = true
  const { host, root } = await mount()
  expect(host.querySelector('h1')?.textContent).toContain('Guildhall')
  expect(host.textContent).not.toContain('guildd:')
  await click(option(host, 'About passkeys'))
  expect(host.textContent).toContain('Member')
  expect(host.textContent).toContain('passkey')
  await act(async () => root.unmount())
})

test('keyboard only: Enter on Continue signs in', async () => {
  foundingIsOpen = false
  signInStatus = 200
  const { host, root } = await mount()
  const continueRow = option(host, 'Continue')
  await key('Enter', continueRow)
  expect(urls).toContain('/api/sign-in/finish')
  expect(host.querySelector('[data-testid="game-frame"]')).not.toBeNull()
  await act(async () => root.unmount())
})

test('a passkey the browser cannot offer for this address has its own line, apart from cancel and refusal', async () => {
  foundingIsOpen = false
  signInStatus = 200
  const denied = (name: string) => ({
    create: async () => ({}),
    get: async () => {
      const error = new Error(name)
      error.name = name
      throw error
    },
  })
  const lineFor = async (name: string) => {
    urls.length = 0
    cookieLive = false
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<App browser={denied(name)} />)
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await click(option(host, 'Continue'))
    const line = host.querySelector('[role="alert"]')?.textContent ?? ''
    await act(async () => root.unmount())
    return line
  }
  const wrong = await lineFor('SecurityError')
  const none = await lineFor('NoPasskeyOffered')
  const cancelled = await lineFor('NotAllowedError')
  expect(wrong).toContain('address')
  expect(none).toContain('address')
  expect(new Set([wrong, none, cancelled]).size).toBe(3)
  expect(cancelled).not.toContain('address')
})

async function signedIn(path = '/') {
  foundingIsOpen = false
  signInStatus = 200
  visit(path)
  const mounted = await mount()
  await click(option(mounted.host, 'Continue'))
  return mounted
}

async function key(k: string, target: EventTarget = document) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

const bagOpen = (host: HTMLElement) => host.querySelector('dialog.bag[open]') !== null

function row(host: HTMLElement, label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.textContent === label
  )
  if (!found) {
    throw new Error(`no Bag row "${label}"`)
  }
  return found
}

test('B opens the Bag and Esc closes it, and focus returns to the world', async () => {
  const { host, root } = await signedIn()
  expect(bagOpen(host)).toBe(false)
  await key('b')
  expect(bagOpen(host)).toBe(true)
  await key('Escape', host.querySelector('[role="option"]') as HTMLElement)
  expect(bagOpen(host)).toBe(false)
  expect(document.activeElement).toBe(host.querySelector('[data-testid="game-frame"]'))
  await act(async () => root.unmount())
})

test('B typed into a field does not open the Bag', async () => {
  const { host, root } = await signedIn()
  const field = document.createElement('input')
  host.appendChild(field)
  await key('b', field)
  expect(bagOpen(host)).toBe(false)
  await act(async () => root.unmount())
})

test('the HUD has a Bag button that opens the Bag, and a Seal count that opens the Seals page', async () => {
  const { host, root } = await signedIn()
  await click(button(host, 'Bag (B)'))
  expect(bagOpen(host)).toBe(true)
  await key('Escape', host.querySelector('[role="option"]') as HTMLElement)
  await click(host.querySelector('.hud-seals') as HTMLElement)
  expect(host.querySelector('dialog[open] #seals-title')).not.toBeNull()
  await act(async () => root.unmount())
})

test('choosing a row opens its page, Esc closes the Bag and the address returns to /', async () => {
  const { host, root } = await signedIn()
  await key('b')
  await click(row(host, 'Treasury'))
  expect(window.location.pathname).toBe('/treasury')
  expect(host.querySelector('dialog[open] #treasury-title')).not.toBeNull()
  await key('Escape', host.querySelector('dialog.bag') as HTMLElement)
  expect(bagOpen(host)).toBe(false)
  expect(window.location.pathname).toBe('/')
  await act(async () => root.unmount())
})

test('signed in: the plate names the guild, the Bag has Sign out, and guildd shows only while down (U4, U5, U1)', async () => {
  const { host, root } = await signedIn()
  const plate = host.querySelector('h1')
  expect(plate?.textContent).toContain('Ember Guild')
  expect(host.textContent).not.toContain('guildd:')
  await key('b')
  await click(row(host, 'Sign out'))
  expect(window.location.pathname).toBe('/')
  expect(option(host, 'Continue')).toBeTruthy()
  await act(async () => root.unmount())
})

test('Sign out from a deeper page returns to / (U4)', async () => {
  const { host, root } = await signedIn('/timeline')
  expect(window.location.pathname).toBe('/timeline')
  await click(button(host.querySelector('dialog.bag') as HTMLElement, 'Back to the Bag'))
  await click(row(host, 'Sign out'))
  expect(window.location.pathname).toBe('/')
  await act(async () => root.unmount())
})

test('the guild id appears only in Settings, truncated with a copy button (U5)', async () => {
  const { host, root } = await signedIn('/vault')
  const settings = host.querySelector('dialog.bag') as HTMLElement
  expect(settings.textContent).not.toContain(guild)
  expect(settings.textContent).toContain(`${guild.slice(0, 8)}…${guild.slice(-4)}`)
  expect(button(settings, 'Copy guild id')).toBeTruthy()
  expect(settings.textContent).toContain('Hall lighting')
  await act(async () => root.unmount())
})

test('document.title names the open Bag page (F3)', async () => {
  const { host, root } = await signedIn('/')
  expect(document.title).toBe('Guildhall')
  await key('b')
  await click(row(host, 'Seals'))
  expect(document.title).toBe('Seals | Guildhall')
  await act(async () => root.unmount())
})

test('an unknown path redirects to / (U18)', async () => {
  const { root } = await signedIn('/no-such-view')
  expect(window.location.pathname).toBe('/')
  await act(async () => root.unmount())
})

test('Sign out resets the document title to Guildhall (shot 51)', async () => {
  const { host, root } = await signedIn('/seals')
  expect(document.title).toBe('Seals | Guildhall')
  await click(button(host.querySelector('dialog.bag') as HTMLElement, 'Back to the Bag'))
  await click(row(host, 'Sign out'))
  expect(document.title).toBe('Guildhall')
  await act(async () => root.unmount())
})

test('an unknown path redirects to / and keeps the query string, so ?seal= survives', async () => {
  const { host, root } = await signedIn('/no-such-view?seal=abc')
  expect(window.location.pathname).toBe('/')
  expect(window.location.search).toBe('?seal=abc')
  expect(host.querySelector('#seals-title')).not.toBeNull()
  await act(async () => root.unmount())
})

test('a reload keeps the Guild Master signed in through the cookie, with no passkey prompt', async () => {
  const first = await signedIn('/timeline')
  await act(async () => first.root.unmount())
  const { host, root } = await mount({ keepSession: true })
  expect(host.textContent).toContain('Ember Guild')
  expect(window.location.pathname).toBe('/timeline')
  expect(urls).not.toContain('/api/sign-in/begin')
  await act(async () => root.unmount())
})

test('sign-in asks for a cookie session and no request carries a bearer token', async () => {
  const { root } = await signedIn()
  const finish = requests.find((r) => r.url === '/api/sign-in/finish')
  expect(finish?.headers.get('x-session-mode')).toBe('cookie')
  const bearers = requests
    .map((r) => r.headers.get('authorization'))
    .filter((h) => h?.includes('tok'))
  expect(bearers).toEqual([])
  await act(async () => root.unmount())
})

test('Sign out revokes the session on guildd, and a reload stays signed out', async () => {
  const { host, root } = await signedIn()
  await key('b')
  await click(row(host, 'Sign out'))
  expect(requests.some((r) => r.url === '/api/session/logout' && r.method === 'POST')).toBe(true)
  await act(async () => root.unmount())
  const again = await mount({ keepSession: true })
  expect(option(again.host, 'Continue')).toBeTruthy()
  await act(async () => again.root.unmount())
})
