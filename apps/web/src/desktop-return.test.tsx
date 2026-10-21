import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const realFetch = globalThis.fetch

// A normal browser opened by the desktop shell: ?desktop=1, with a live passkey session.
GlobalRegistrator.register({ url: 'http://localhost/?desktop=1' })
const { createRoot } = await import('react-dom/client')
const { App } = await import('./App')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === '/api/session') {
        return Response.json({ guildId: guild })
      }
      if (url === '/api/health') {
        return Response.json({ status: 'ok' })
      }
      if (url === '/api/founding') {
        return Response.json({ open: false })
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

test('signed in with ?desktop=1 in a normal browser, the page offers the way back to the app instead of the world', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    createRoot(host).render(<App browser={{ create: async () => ({}), get: async () => ({}) }} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const button = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Return to the Guildhall app')
  )
  expect(button).toBeTruthy()
  expect(host.querySelector('nav')).toBeNull()
})
