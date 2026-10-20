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
  expect(host.querySelector('header')?.textContent).not.toContain(guild)
  expect(host.querySelector('#home-heading')).not.toBeNull()
  expect(host.querySelector('#vault-heading')).toBeNull()
  await act(async () => root.unmount())
})

test('signed in, only the active view renders and the nav moves between views', async () => {
  foundingIsOpen = false
  signInStatus = 200
  visit('/')
  const { host, root } = await mount()
  await click(button(host, 'Sign in with passkey'))
  const nav = host.querySelector('nav[aria-label="Ledger"]')
  const labels = [...(nav?.querySelectorAll('a') ?? [])].map((a) => a.textContent?.trim())
  expect(labels).toEqual([
    'Home',
    'Guild Hall',
    'Quest Board',
    'Seals',
    'Archive',
    'Treasury and Costs',
    'Roster and Summon',
    'Guild',
    'Workflows',
    'Gates',
    'Timeline',
    'Vault and Settings',
  ])
  const link = [...(nav?.querySelectorAll('a') ?? [])].find(
    (a) => a.textContent?.trim() === 'Treasury and Costs'
  )
  if (!link) {
    throw new Error('no Treasury link')
  }
  await click(link)
  expect(window.location.pathname).toBe('/treasury')
  expect(host.querySelector('#treasury-heading')).not.toBeNull()
  expect(host.querySelector('#home-heading')).toBeNull()
  expect(host.querySelectorAll('main h1').length).toBe(1)
  await act(async () => root.unmount())
})

test('a deep link opens its own view, and a Seal link opens the Seals view', async () => {
  foundingIsOpen = false
  signInStatus = 200
  visit('/vault')
  const first = await mount()
  await click(button(first.host, 'Sign in with passkey'))
  expect(first.host.querySelector('#vault-heading')).not.toBeNull()
  expect(first.host.querySelector('#home-heading')).toBeNull()
  await act(async () => first.root.unmount())

  visit('/?seal=abc')
  const second = await mount()
  await click(button(second.host, 'Sign in with passkey'))
  expect(second.host.querySelector('#seals-heading')).not.toBeNull()
  await act(async () => second.root.unmount())
  visit('/')
})

test('signed out at a deep link shows only sign-in, never the view', async () => {
  foundingIsOpen = false
  visit('/vault')
  const { host, root } = await mount()
  expect(button(host, 'Sign in with passkey')).toBeTruthy()
  expect(host.querySelector('#vault-heading')).toBeNull()
  expect(host.querySelector('nav')).toBeNull()
  await act(async () => root.unmount())
  visit('/')
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

test('a rate-limited /founding shows a try again shortly state instead of vanishing (B3)', async () => {
  foundingIsOpen = true
  foundingStatus = 429
  const { host, root } = await mount()
  expect(host.textContent).toContain('try again shortly')
  foundingStatus = 200
  await act(async () => root.unmount())
})

test('signed out: says what Guildhall and a passkey are, and shows guildd only when it is down', async () => {
  foundingIsOpen = true
  const { host, root } = await mount()
  expect(host.textContent).toContain('What is a passkey')
  expect(host.textContent).not.toContain('guildd:')
  const sign = button(host, 'Sign in with passkey')
  expect(sign.className).toContain('btn-primary')
  const found = button(host, 'Found your guild')
  expect(found.className).not.toContain('btn-primary')
  await act(async () => root.unmount())
})

async function signedIn(path = '/') {
  foundingIsOpen = false
  signInStatus = 200
  visit(path)
  const mounted = await mount()
  await click(button(mounted.host, 'Sign in with passkey'))
  return mounted
}

test('signed in: the header names the guild, has Sign out, and hides guildd while ok (U4, U5, U1)', async () => {
  const { host, root } = await signedIn()
  const header = host.querySelector('header')
  expect(header?.textContent).toContain('Ember Guild')
  expect(header?.textContent).not.toContain('guildd:')
  expect(header?.textContent).not.toContain(guild)
  await click(button(header as HTMLElement, 'Sign out'))
  expect(window.location.pathname).toBe('/')
  expect(button(host, 'Sign in with passkey')).toBeTruthy()
  await act(async () => root.unmount())
})

test('Sign out from a deeper view returns to / (U4)', async () => {
  const { host, root } = await signedIn('/timeline')
  expect(window.location.pathname).toBe('/timeline')
  await click(button(host.querySelector('header') as HTMLElement, 'Sign out'))
  expect(window.location.pathname).toBe('/')
  await act(async () => root.unmount())
})

test('the guild id appears only in Vault and Settings, truncated with a copy button (U5)', async () => {
  const { host, root } = await signedIn('/vault')
  const main = host.querySelector('main')
  expect(main?.textContent).not.toContain(guild)
  expect(main?.textContent).toContain(`${guild.slice(0, 8)}…${guild.slice(-4)}`)
  expect(button(main as HTMLElement, 'Copy guild id')).toBeTruthy()
  await act(async () => root.unmount())
})

test('document.title names the view (F3)', async () => {
  const { host, root } = await signedIn('/')
  expect(document.title).toBe('Home | Guildhall')
  const link = [...host.querySelectorAll('nav a')].find((a) => a.textContent === 'Seals')
  await click(link as HTMLElement)
  expect(document.title).toBe('Seals | Guildhall')
  await act(async () => root.unmount())
})

test('an unknown path redirects to / (U18)', async () => {
  const { root } = await signedIn('/no-such-view')
  expect(window.location.pathname).toBe('/')
  await act(async () => root.unmount())
})

test('the phone nav has a More menu that opens and closes (U10)', async () => {
  const { host, root } = await signedIn('/')
  const more = button(host.querySelector('nav') as HTMLElement, 'More')
  expect(more.getAttribute('aria-expanded')).toBe('false')
  await click(more)
  expect(more.getAttribute('aria-expanded')).toBe('true')
  const link = [...host.querySelectorAll('nav a')].find((a) => a.textContent === 'Timeline')
  await click(link as HTMLElement)
  expect(
    button(host.querySelector('nav') as HTMLElement, 'More').getAttribute('aria-expanded')
  ).toBe('false')
  await act(async () => root.unmount())
})

test('the active tab is scrolled into view (F2)', async () => {
  const scrolled: string[] = []
  const original = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.textContent ?? '')
  }
  const { host, root } = await signedIn('/')
  const link = [...host.querySelectorAll('nav a')].find((a) => a.textContent === 'Quest Board')
  await click(link as HTMLElement)
  HTMLElement.prototype.scrollIntoView = original
  expect(scrolled).toContain('Quest Board')
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
  await click(button(host.querySelector('header') as HTMLElement, 'Sign out'))
  expect(requests.some((r) => r.url === '/api/session/logout' && r.method === 'POST')).toBe(true)
  await act(async () => root.unmount())
  const again = await mount({ keepSession: true })
  expect(button(again.host, 'Sign in with passkey')).toBeTruthy()
  await act(async () => again.root.unmount())
})
