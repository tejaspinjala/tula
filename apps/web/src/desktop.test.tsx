import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import {
  beginDesktopHandoff,
  CEREMONY_TIMEOUT_MS,
  desktopCodeFromHash,
  desktopRequested,
  desktopReturnUrl,
  exchangeDesktopCode,
  isDesktopShell,
  type PasskeyBrowser,
  passkeyFailure,
  passkeyLine,
  takeDesktopCode,
  withCeremonyTimeout,
} from './passkeys'

const guild = '11111111-1111-4111-8111-111111111111'
const code = `${guild}.c2VjcmV0LXNlY3JldC1zZWNyZXQ`

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { SignInPanel } = await import('./SignInPanel')
const { DesktopReturn } = await import('./DesktopReturn')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('the shell is recognised by the user-agent suffix it sets, and nothing else', () => {
  expect(isDesktopShell('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 GuildhallDesktop/0.1')).toBe(
    true
  )
  expect(isDesktopShell('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15')).toBe(false)
  expect(isDesktopShell('')).toBe(false)
})

test('?desktop=1 asks for the hand-back to the app, any other query does not', () => {
  expect(desktopRequested('?desktop=1')).toBe(true)
  expect(desktopRequested('?a=b&desktop=1')).toBe(true)
  expect(desktopRequested('?desktop=2')).toBe(false)
  expect(desktopRequested('')).toBe(false)
})

test('the desktop code is read from the fragment only, and taking it clears the address bar', () => {
  expect(desktopCodeFromHash(`#desktop-code=${code}`)).toBe(code)
  expect(desktopCodeFromHash('#desktop-code=')).toBeNull()
  expect(desktopCodeFromHash('#desktop-code=junk')).toBeNull()
  expect(desktopCodeFromHash(`?desktop-code=${code}`)).toBeNull()
  const calls: string[] = []
  const place = {
    location: { hash: `#desktop-code=${code}`, pathname: '/', search: '' },
    history: { replaceState: (_s: unknown, _t: string, url: string) => calls.push(url) },
  }
  expect(takeDesktopCode(place)).toBe(code)
  expect(calls).toEqual(['/'])
  expect(
    takeDesktopCode({ ...place, location: { hash: '', pathname: '/', search: '' } })
  ).toBeNull()
})

test('the hand-off url puts the code in the fragment of the guildhall scheme', () => {
  expect(desktopReturnUrl(code)).toBe(`guildhall://signed-in#code=${code}`)
})

test('beginning a hand-off posts to guildd with the cookie session and returns the code', async () => {
  const seen: Array<{ url: string; method: string | undefined }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method })
    return Response.json({ code, expiresAt: '2026-01-01T00:01:00.000Z' }, { status: 201 })
  }
  expect(await beginDesktopHandoff(fetcher)).toBe(code)
  expect(seen).toEqual([{ url: '/api/auth/desktop/begin', method: 'POST' }])
})

test('exchanging a code posts it in the body and asks for a cookie session', async () => {
  const seen: Array<{ url: string; body: unknown; mode: string | null }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      body: JSON.parse(String(init?.body)),
      mode: new Headers(init?.headers).get('x-session-mode'),
    })
    return Response.json({ guildId: guild }, { status: 201 })
  }
  expect(await exchangeDesktopCode(code, fetcher)).toEqual({ token: '', guildId: guild })
  expect(seen).toEqual([{ url: '/api/auth/desktop/exchange', body: { code }, mode: 'cookie' }])
})

const stuck = (seen: { signal?: AbortSignal | undefined }): PasskeyBrowser => ({
  create: (_options, signal) => {
    seen.signal = signal
    return new Promise(() => {})
  },
  get: (_options, signal) => {
    seen.signal = signal
    return new Promise(() => {})
  },
})

test('a ceremony that never settles is aborted after a bounded time and reads as a timeout', async () => {
  expect(CEREMONY_TIMEOUT_MS).toBe(60_000)
  const creation = {
    challenge: 'abc',
    rp: { name: 'x' },
    user: { id: 'u', name: 'n', displayName: 'n' },
    pubKeyCredParams: [],
  }
  const calls = [
    (b: PasskeyBrowser) => b.create(creation),
    (b: PasskeyBrowser) => b.get({ challenge: 'abc' }),
  ]
  for (const call of calls) {
    const seen: { signal?: AbortSignal | undefined } = {}
    const error = await call(withCeremonyTimeout(stuck(seen), 20)).then(
      () => null,
      (caught: unknown) => caught
    )
    expect(passkeyFailure(error)).toBe('timeout')
    expect(seen.signal?.aborted).toBe(true)
  }
})

test('a ceremony that settles in time passes through untouched', async () => {
  const quick: PasskeyBrowser = {
    create: async () => ({ made: true }),
    get: async () => ({ signed: true }),
  }
  const browser = withCeremonyTimeout(quick, 20)
  expect(await browser.get({ challenge: 'abc' })).toEqual({ signed: true })
  await Bun.sleep(40)
})

test('every step has a timeout line that says what to do next', () => {
  for (const step of ['sign-in', 'founding', 'enrol'] as const) {
    expect(passkeyLine('timeout', step)).toContain('Try again')
  }
})

async function mount(element: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(element)
  })
  return host
}

function labels(host: HTMLElement) {
  return [...host.querySelectorAll('button, [role="menuitem"], [role="option"]')].map((b) =>
    b.textContent?.trim()
  )
}

test('inside the desktop shell the title offers only to sign in with the browser', async () => {
  const opened: string[] = []
  const host = await mount(
    <SignInPanel
      fetcher={fetch}
      browser={{ create: async () => ({}), get: async () => ({}) }}
      founding="open"
      desktopShell
      openInBrowser={() => opened.push('browser')}
      onSession={() => {}}
    />
  )
  expect(labels(host).join('|')).toContain('Sign in with your browser')
  expect(host.textContent).not.toContain('Continue')
  expect(host.textContent).not.toContain('New guild')
  expect(host.textContent).not.toContain('Older passkey')
  const choice = [...host.querySelectorAll('*')].find(
    (el) => el.children.length === 0 && el.textContent?.includes('Sign in with your browser')
  )
  await act(async () => {
    ;(choice?.closest('button, [role="menuitem"], [role="option"], li') as HTMLElement)?.click()
  })
  expect(opened).toEqual(['browser'])
})

test('the return step mints a code on click and hands the guildhall url to the OS', async () => {
  const navigated: string[] = []
  const fetcher = async () => Response.json({ code, expiresAt: 'x' }, { status: 201 })
  const host = await mount(<DesktopReturn fetcher={fetcher} navigate={(u) => navigated.push(u)} />)
  const button = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Return to the Guildhall app')
  )
  expect(button).toBeTruthy()
  expect(navigated).toEqual([])
  await act(async () => {
    button?.click()
  })
  expect(navigated).toEqual([`guildhall://signed-in#code=${code}`])
})

test('a refused hand-off shows a pixel line and never navigates', async () => {
  const navigated: string[] = []
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  const host = await mount(<DesktopReturn fetcher={fetcher} navigate={(u) => navigated.push(u)} />)
  await act(async () => {
    host.querySelector('button')?.click()
  })
  expect(host.querySelector('[role="alert"]')?.textContent?.length).toBeGreaterThan(0)
  expect(navigated).toEqual([])
})
