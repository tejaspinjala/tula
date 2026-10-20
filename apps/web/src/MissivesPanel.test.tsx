import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { MissivesPanel } = await import('./MissivesPanel')
const { LiveEvents } = await import('./live-events')

const urls: string[] = []
const fresh: ReturnType<typeof missive>[] = []
const missive = (id: string, from: string, to: string, text: string) => ({
  id,
  from,
  to,
  text,
  sentAt: '2026-01-01T00:00:00.000Z',
})
const roster = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    {
      id: 'heralds',
      name: 'Heralds Hall',
      kind: 'work',
      locked: false,
      captain: { id: 'heralds-captain', name: 'Herald Captain' },
      members: [{ id: 'heralds-member-2', name: 'Herald Journeyman', rank: 'journeyman' }],
    },
    { id: 'health', name: 'Health', kind: 'private', locked: true, captain: null, members: [] },
  ],
  next: null,
}

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      urls.push(url)
      if (url.includes('/roster')) {
        return Response.json(roster)
      }
      if (url.includes('/halls/heralds/missives') && url.includes('after=3')) {
        return Response.json({
          missives: [missive('m1', 'heralds-captain', 'hall', 'Welcome to the Campaign.')],
          next: null,
        })
      }
      if (url.includes('/halls/heralds/missives')) {
        return Response.json({
          missives: [
            ...fresh,
            missive('m3', 'heralds-member-2', 'heralds-captain', '<b>Which tone?</b>'),
            missive('m2', 'heralds-captain', 'heralds-member-2', 'Warm and brief.'),
          ],
          next: 3,
        })
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

async function mount(ui: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(ui)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  return { host, unmount: () => act(async () => root.unmount()) }
}

test('a Hall’s exchange is listed newest first with Member names, as plain text', async () => {
  const m = await mount(<MissivesPanel session={session} />)
  const heading = m.host.querySelector('h2')
  expect(heading?.textContent).toBe('Guild chat')
  const rows = [...m.host.querySelectorAll('[data-testid="missive"]')].map((r) => r.textContent)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('Herald Journeyman')
  expect(rows[0]).toContain('Herald Captain')
  expect(rows[0]).toContain('<b>Which tone?</b>')
  expect(rows[1]).toContain('Warm and brief.')
  expect(m.host.querySelector('b')).toBeNull()
  expect(urls.some((u) => u.includes('/halls/heralds/missives?limit=20'))).toBe(true)
  await m.unmount()
})

test('only Halls that can have Members are offered', async () => {
  const m = await mount(<MissivesPanel session={session} />)
  const options = [...m.host.querySelectorAll('select[name="missive-hall"] option')].map(
    (o) => o.textContent
  )
  expect(options).toEqual(['Heralds Hall'])
  await m.unmount()
})

test('older Missives load on request and are appended below', async () => {
  const m = await mount(<MissivesPanel session={session} />)
  const more = [...m.host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Load older missives'
  )
  expect(more).toBeDefined()
  await act(async () => {
    more?.click()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const rows = [...m.host.querySelectorAll('[data-testid="missive"]')].map((r) => r.textContent)
  expect(rows).toHaveLength(3)
  expect(rows[2]).toContain('Welcome to the Campaign.')
  expect(
    [...m.host.querySelectorAll('button')].some((b) => b.textContent === 'Load older missives')
  ).toBe(false)
  await m.unmount()
})

test('signed out, it asks for a passkey and reads nothing', async () => {
  urls.length = 0
  const m = await mount(<MissivesPanel session={null} />)
  expect(m.host.textContent).toContain('Sign in')
  expect(urls).toEqual([])
  await m.unmount()
})

test('a new Missive arrives live: missive.sent refetches the list by route', async () => {
  fresh.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const sent = {
    seq: 9,
    type: 'missive.sent',
    payload: { missiveId: 'm9', hall: 'heralds', from: 'heralds-captain' },
    occurredAt: '2026-01-01T00:00:00.000Z',
  }
  await act(async () => {
    root.render(
      <LiveEvents.Provider value={[]}>
        <MissivesPanel session={session} />
      </LiveEvents.Provider>
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(host.querySelectorAll('[data-testid="missive"]')).toHaveLength(2)
  fresh.push(missive('m9', 'heralds-captain', 'hall', 'Fresh from the road.'))
  await act(async () => {
    root.render(
      <LiveEvents.Provider value={[sent]}>
        <MissivesPanel session={session} />
      </LiveEvents.Provider>
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const rows = [...host.querySelectorAll('[data-testid="missive"]')].map((r) => r.textContent)
  expect(rows).toHaveLength(3)
  expect(rows[0]).toContain('Fresh from the road.')
  await act(async () => root.unmount())
  fresh.length = 0
})

test('the Guild Master can address a Member from the chat through the talk path', async () => {
  const talked: string[] = []
  const m = await mount(<MissivesPanel session={session} onTalk={(id) => talked.push(id)} />)
  expect(m.host.querySelector('select[name="chat-member"]')).not.toBeNull()
  const talk = [...m.host.querySelectorAll('button')].find((b) => b.textContent === 'Talk')
  await act(async () => talk?.click())
  expect(talked).toEqual(['heralds-captain'])
  await m.unmount()
})

test('without a talk path, the chat offers no addressing', async () => {
  const m = await mount(<MissivesPanel session={session} />)
  expect(m.host.querySelector('select[name="chat-member"]')).toBeNull()
  await m.unmount()
})
