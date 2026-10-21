import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { AwayBadge } = await import('./AwayBadge')

let away = true
const calls: string[] = []

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request) => {
      const path = String(url)
      calls.push(path)
      if (path.endsWith('/return')) {
        away = false
      }
      return Response.json(
        away
          ? { away: true, since: '2026-03-01T08:00:00.000Z', until: null }
          : { away: false, since: null, until: null }
      )
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

test('the badge shows while away, and one tap on I am back removes it', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AwayBadge session={session} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  expect(host.textContent).toContain('Away')
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === "I'm back")
  expect(button).toBeDefined()
  await act(async () => {
    button?.click()
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  expect(calls.some((c) => c.endsWith('/guild-master/return'))).toBe(true)
  expect(host.textContent).toBe('')
  await act(async () => root.unmount())
})
