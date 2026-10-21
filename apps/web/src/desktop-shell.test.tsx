import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const code = `${guild}.c2VjcmV0LXNlY3JldC1zZWNyZXQ`
const realFetch = globalThis.fetch

// The desktop shell loads the page with its user-agent suffix and, after the deep link, the code.
GlobalRegistrator.register({
  url: `http://localhost/#desktop-code=${code}`,
  settings: { navigator: { userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15 GuildhallDesktop/0.1' } },
})
const { createRoot } = await import('react-dom/client')
const { App } = await import('./App')

let cookieLive = false
let exchangeStatus = 201
const requests: { url: string; body: unknown; mode: string | null }[] = []

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      requests.push({
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        mode: new Headers(init?.headers).get('x-session-mode'),
      })
      if (url === '/api/session') {
        return cookieLive
          ? Response.json({ guildId: guild })
          : Response.json({ error: 'unauthenticated' }, { status: 401 })
      }
      if (url === '/api/auth/desktop/exchange') {
        if (exchangeStatus !== 201) {
          return Response.json({ error: 'invalid_challenge' }, { status: exchangeStatus })
        }
        cookieLive = true
        return Response.json({ guildId: guild }, { status: 201 })
      }
      if (url === '/api/health') {
        return Response.json({ status: 'ok' })
      }
      if (url === '/api/founding') {
        return Response.json({ open: true })
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

async function mount() {
  requests.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(<App browser={{ create: async () => ({}), get: async () => ({}) }} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return host
}

test('the code the deep link delivered is cleared from the address bar, then exchanged for a session', async () => {
  const host = await mount()
  expect(window.location.hash).toBe('')
  const exchanges = requests.filter((r) => r.url === '/api/auth/desktop/exchange')
  expect(exchanges).toEqual([{ url: '/api/auth/desktop/exchange', body: { code }, mode: 'cookie' }])
  expect(requests.some((r) => r.url === `/api/guilds/${guild}`)).toBe(true)
  expect(host.textContent).not.toContain('Sign in with your browser')
})

test('a code that no longer works leaves the title offering only the browser, with a line saying so', async () => {
  cookieLive = false
  exchangeStatus = 400
  window.location.hash = `#desktop-code=${code}`
  const host = await mount()
  const options = [...host.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim())
  expect(options).toEqual(['Sign in with your browser'])
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Sign in with your browser')
})
