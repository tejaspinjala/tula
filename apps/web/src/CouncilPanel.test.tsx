import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { CouncilPanel } = await import('./CouncilPanel')

const VOICES = ['architect', 'skeptic', 'security', 'ops', 'user']
const sealId = '22222222-2222-4222-8222-222222222222'
const hash = 'ab12cd34'.repeat(8)
const sess = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  questId: `quest-${id}`,
  proposalHash: hash,
  day: '2026-10-20',
  status: 'escalated',
  reason: 'block',
  createdAt: '2026-10-20T10:00:00.000Z',
  sealId,
  costMicros: 1500,
  votes: VOICES.map((voice) => ({
    voice,
    vote: voice === 'skeptic' ? 'block' : 'approve',
    reasons: voice === 'skeptic' ? ['<b>too risky</b>'] : ['fine'],
    abstainCode: null,
  })),
  ...over,
})

const urls: string[] = []
beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      urls.push(url)
      if (url.includes('after=s1')) {
        return Response.json({
          sessions: [sess('s0', { status: 'approved', sealId: null })],
          next: null,
        })
      }
      return Response.json({
        sessions: [sess('s1'), sess('s2', { status: 'strange', sealId: null, costMicros: null })],
        next: 's1',
      })
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
async function mount(ui: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(ui)
    await wait()
  })
  return { host, unmount: () => act(async () => root.unmount()) }
}
async function press(host: HTMLElement, label: string, nth = 0) {
  const b = [...host.querySelectorAll('button')].filter((x) => x.textContent === label)[nth]
  expect(b).toBeDefined()
  await act(async () => {
    b?.click()
    await wait()
  })
}

test('lists sessions with Proposal prefix, Quest, outcome and cost; unknown status reads safely', async () => {
  const m = await mount(<CouncilPanel session={session} />)
  const rows = [...m.host.querySelectorAll('[data-testid="council-row"]')]
  expect(rows).toHaveLength(2)
  const first = rows[0]?.textContent ?? ''
  expect(first).toContain('ab12cd34')
  expect(first).toContain('quest-s1')
  expect(first).toContain('Sent to the Seal desk')
  expect(first).toContain('$0.0015')
  expect(rows[1]?.textContent).toContain('Unknown')
  expect(rows[1]?.textContent).toContain('not metered')
  await m.unmount()
})

test('opening a session shows each elder vote and reasons as text, and an escalated one links to its Seal', async () => {
  const m = await mount(<CouncilPanel session={session} />)
  await press(m.host, 'Open')
  const detail = m.host.querySelector('[data-testid="council-detail"]')
  expect(detail?.querySelectorAll('li')).toHaveLength(5)
  expect(detail?.textContent).toContain('<b>too risky</b>')
  expect(detail?.querySelector('b')).toBeNull()
  expect(detail?.textContent).toContain('Block')
  const link = detail?.querySelector('a')
  expect(link?.getAttribute('href')).toBe(`/seals?seal=${sealId}`)
  await m.unmount()
})

test('Load older pages with the cursor', async () => {
  const m = await mount(<CouncilPanel session={session} />)
  await press(m.host, 'Load older')
  expect(urls.some((u) => u.includes('after=s1'))).toBe(true)
  expect(m.host.querySelectorAll('[data-testid="council-row"]')).toHaveLength(3)
  expect(m.host.textContent).not.toContain('Load older')
  await m.unmount()
})
