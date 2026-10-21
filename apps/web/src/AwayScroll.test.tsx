import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch
const SINCE = '2026-03-01T08:00:00.000Z'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { AwayScroll } = await import('./AwayScroll')
const { announceReturn, requestAwayScroll } = await import('./away-digest')

let away = false
let window_: { since: string; until: string | null; open: boolean } | null = null
const entries = [
  {
    seq: 5,
    kind: 'council_approved',
    occurredAt: '2026-03-01T09:00:00.000Z',
    questId: 'q1',
    sessionId: 'sess-1',
    sealId: null,
    reason: null,
    amountCents: null,
    status: null,
  },
  {
    seq: 6,
    kind: 'escalated',
    occurredAt: '2026-03-01T10:00:00.000Z',
    questId: 'q2',
    sessionId: 'sess-2',
    sealId: null,
    reason: 'blocked',
    amountCents: null,
    status: null,
  },
]

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request) => {
      const path = String(url)
      if (path.includes('/away-digest')) {
        return Response.json({
          window: window_,
          entries: window_ ? entries : [],
          next: null,
          spendTotalCents: 320,
        })
      }
      return Response.json(
        away ? { away: true, since: SINCE, until: null } : { away: false, since: null, until: null }
      )
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  localStorage.clear()
  away = false
  window_ = { since: SINCE, until: '2026-03-01T12:00:00.000Z', open: false }
})

async function mount(onOpenCouncil: (id: string) => void = () => {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AwayScroll session={session} onOpenCouncil={onOpenCouncil} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const dialog = () => host.querySelector('dialog')
  const unmount = () => act(async () => root.unmount())
  return { host, dialog, unmount }
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)))

test('opens once on load for a window that ended unseen, listing what happened', async () => {
  const first = await mount()
  expect(first.dialog()?.open).toBe(true)
  expect(first.host.textContent).toContain('While you were away')
  expect(first.host.textContent).toContain('blocked')
  expect(first.host.querySelectorAll('li')).toHaveLength(2)
  expect(first.host.textContent).toContain('Treasury spend in all: $3.20')
  await first.unmount()
  const again = await mount()
  expect(again.dialog()?.open ?? false).toBe(false)
  await again.unmount()
})

test('stays shut while the Guild Master is still away', async () => {
  away = true
  window_ = { since: SINCE, until: null, open: true }
  const view = await mount()
  expect(view.dialog()?.open ?? false).toBe(false)
  await view.unmount()
})

test('opens when the Guild Master returns in this tab', async () => {
  away = true
  window_ = { since: SINCE, until: null, open: true }
  const view = await mount()
  expect(view.dialog()?.open ?? false).toBe(false)
  away = false
  window_ = { since: SINCE, until: '2026-03-01T12:00:00.000Z', open: false }
  await act(async () => announceReturn())
  await settle()
  expect(view.dialog()?.open).toBe(true)
  await view.unmount()
})

test('can be reopened from the Bag even when already seen', async () => {
  const view = await mount()
  await act(async () => view.host.querySelector('button')?.click())
  expect(view.dialog()?.open).toBe(false)
  await act(async () => requestAwayScroll())
  await settle()
  expect(view.dialog()?.open).toBe(true)
  await view.unmount()
})

test('reopening with no window to tell of says so', async () => {
  window_ = null
  const view = await mount()
  expect(view.dialog()?.open ?? false).toBe(false)
  await act(async () => requestAwayScroll())
  await settle()
  expect(view.host.textContent).toContain('Nothing happened')
  await view.unmount()
})

test('a Council entry opens its votes and closes the scroll', async () => {
  const opened: string[] = []
  const view = await mount((id) => opened.push(id))
  const button = [...view.host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Open votes'
  )
  expect(button).toBeDefined()
  await act(async () => button?.click())
  expect(opened).toEqual(['sess-1'])
  expect(view.dialog()?.open).toBe(false)
  await view.unmount()
})
