import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { HomePanel } = await import('./HomePanel')

let barred = false
let sealsWaiting = 0
let cost = { posts: 0, costMicros: 0, costPerPostMicros: 0 }

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/gates/bar') && init?.method === 'POST') {
        barred = true
        return Response.json({
          barId: 'b',
          scope: 'guild',
          created: true,
          revokedRuns: 0,
          killedSandboxes: 0,
        })
      }
      if (url.endsWith('/gates')) {
        return Response.json({ guild: barred, global: false })
      }
      if (url.includes('/seals')) {
        return Response.json({
          seals: Array.from({ length: sealsWaiting }, (_, i) => ({
            id: `s${i}`,
            questId: 'q',
            requestedBy: 'm',
            kind: 'post',
            text: 't',
            evidence: 'e',
            actionHash: 'h',
            stale: false,
            status: 'requested',
            requestedAt: '2026-03-01T00:00:00.000Z',
            expiresAt: '2026-03-02T00:00:00.000Z',
            decidedAt: null,
            decisionNote: null,
          })),
          next: null,
        })
      }
      if (url.endsWith('/summon')) {
        return Response.json({ complete: false, steps: [], quest: null })
      }
      if (url.includes('/cost-per-post')) {
        return Response.json({ overall: cost, campaigns: [], next: null })
      }
      if (url.includes('/quests')) {
        return Response.json({ quests: [], next: null })
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
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<HomePanel session={session} navigate={() => {}} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return { host, root }
}

test('after a successful bar the Gates tile reloads and shows barred', async () => {
  barred = false
  const { host, root } = await mount()
  expect(host.textContent).toContain('The Gates are open.')
  const bar = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Bar the Gates')
  await act(async () => {
    bar?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  expect(host.textContent).toContain('The Gates are barred for this guild.')
  await act(async () => root.unmount())
})

test('the Gates link is named Gates settings, so it does not read as lifting the bar', async () => {
  const { host, root } = await mount()
  const links = [...host.querySelectorAll('a')].map((a) => a.textContent)
  expect(links).toContain('Gates settings')
  expect(links).not.toContain('Open the Gates')
  await act(async () => root.unmount())
})

test('the Seals count badge is neutral at 0 and warns when Seals wait', async () => {
  sealsWaiting = 0
  const zero = await mount()
  expect(zero.host.querySelector('.count-badge')?.className).toContain('count-badge-neutral')
  await act(async () => zero.root.unmount())
  sealsWaiting = 2
  const some = await mount()
  expect(some.host.querySelector('.count-badge')?.className).not.toContain('count-badge-neutral')
  await act(async () => some.root.unmount())
  sealsWaiting = 0
})

test('cost per accepted post reads unmetered (subscription) when the spend is all subscription', async () => {
  cost = { posts: 3, costMicros: 0, costPerPostMicros: 0 }
  const { host, root } = await mount()
  expect(host.textContent).toContain('unmetered (subscription)')
  expect(host.textContent).not.toContain('$0.00')
  await act(async () => root.unmount())
  cost = { posts: 0, costMicros: 0, costPerPostMicros: 0 }
})
