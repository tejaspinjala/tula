import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import axe from 'axe-core'
import { act } from 'react'
import type { SceneState } from './game/scene'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const at = '2026-01-01T00:00:00.000Z'
const scene: SceneState = {
  rooms: [
    {
      hallId: 'heralds',
      name: 'Heralds',
      locked: false,
      paused: false,
      memberIds: ['ana', 'bo'],
      board: 0,
    },
  ],
  members: {
    ana: {
      id: 'ana',
      name: 'Ana',
      hallId: 'heralds',
      rank: 'journeyman',
      status: 'working',
      questId: 'q1',
      bubble: null,
      claimSeq: null,
    },
    bo: {
      id: 'bo',
      name: 'Bo',
      hallId: 'heralds',
      rank: 'journeyman',
      status: 'idle',
      questId: null,
      bubble: null,
      claimSeq: null,
    },
  },
  stewardId: 'steward',
  scrolls: [],
  apprentices: [],
  campaigns: [],
  gateClosed: false,
  coinsCents: 0,
  appliedSeq: 5,
}
const quests = [
  { id: 'q1', title: 'Draft the brief', hallId: 'heralds', ownerId: 'ana', state: 'active' },
]
const act1 = (seq: number, memberId: string, activity: string) => ({
  seq,
  type: 'member.activity',
  payload: { questId: 'q1', memberId, hallId: 'heralds', activity },
  occurredAt: at,
})
const events = [
  act1(1, 'ana', 'reading_brief'),
  act1(2, 'bo', 'writing'),
  act1(3, 'ana', 'researching'),
]
const sent = (id: string, from: string, to: string, text: string) => ({
  id,
  from,
  to,
  text,
  hallId: 'heralds',
  toHall: null,
  sentAt: at,
})

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { InspectCard } = await import('./InspectCard')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function show(memberId: string | null = 'ana') {
  const urls: string[] = []
  const calls: string[] = []
  const fetcher = async (url: string) => {
    urls.push(url)
    return Response.json({
      missives: [
        sent('m3', 'bo', 'hall', 'Hall-wide <i>word</i>'),
        sent('m2', 'ana', 'bo', 'Over to you.'),
        sent('m1', 'bo', 'steward', 'Not about Ana.'),
      ],
      next: null,
    })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <InspectCard
        session={session}
        fetcher={fetcher}
        memberId={memberId}
        scene={scene}
        quests={quests}
        events={events}
        onTalk={() => calls.push('talk')}
        onFollow={(id) => calls.push(`follow:${id}`)}
        onClose={() => calls.push('close')}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return {
    host,
    urls,
    calls,
    unmount: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)

test('inspecting a Member shows its Quest, its step, and only its own activity, newest first', async () => {
  const run = await show('ana')
  const dialog = run.host.querySelector('dialog')
  expect(dialog?.open).toBe(true)
  expect(dialog?.getAttribute('aria-labelledby')).toBe('inspect-title')
  expect(run.host.querySelector('#inspect-title')?.textContent).toBe('Ana')
  expect(run.host.textContent).toContain('Draft the brief')
  expect(run.host.textContent).toContain('active')
  const feed = [...run.host.querySelectorAll('[aria-label="Activity"] li')].map(
    (l) => l.textContent
  )
  expect(feed).toHaveLength(2)
  expect(feed[0]).toContain('Researching')
  expect(feed[1]).toContain('Reading the brief')
  expect(run.host.textContent).not.toContain('Writing')
  await run.unmount()
})

test('nothing shows with no Member inspected', async () => {
  const run = await show(null)
  expect(run.host.querySelector('dialog')?.open ?? false).toBe(false)
  expect(run.urls).toEqual([])
  await run.unmount()
})

test('Talk, Follow and Close hand the choice to the page', async () => {
  const run = await show('ana')
  await act(async () => button(run.host, 'Talk')?.click())
  await act(async () => button(run.host, 'Follow this Member')?.click())
  await act(async () => button(run.host, 'Close')?.click())
  expect(run.calls).toEqual(['talk', 'follow:ana', 'close'])
  await run.unmount()
})

test('Missives come from the guild’s Missives route, as text, with Hall-wide ones included', async () => {
  const run = await show('ana')
  expect(run.urls.length).toBeGreaterThan(0)
  for (const url of run.urls) {
    expect(url.startsWith(`/api/guilds/${guild}/halls/heralds/missives`)).toBe(true)
  }
  const rows = [...run.host.querySelectorAll('[data-testid="missive"]')].map((r) => r.textContent)
  expect(rows).toHaveLength(2)
  expect(rows[0]).toContain('Hall-wide <i>word</i>')
  expect(run.host.querySelector('i')).toBeNull()
  expect(run.host.textContent).not.toContain('Not about Ana.')
  await run.unmount()
})

test('older activity is a page further on request', async () => {
  const many = Array.from({ length: 12 }, (_, n) => act1(n + 1, 'ana', 'thinking'))
  const run = await show('ana')
  await run.unmount()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <InspectCard
        session={session}
        fetcher={async () => Response.json({ missives: [], next: null })}
        memberId="ana"
        scene={scene}
        quests={quests}
        events={many}
        onTalk={() => {}}
        onFollow={() => {}}
        onClose={() => {}}
      />
    )
  })
  const count = () => host.querySelectorAll('[aria-label="Activity"] li').length
  expect(count()).toBe(8)
  await act(async () => button(host, 'Show older activity')?.click())
  expect(count()).toBe(12)
  expect(button(host, 'Show older activity')).toBeUndefined()
  await act(async () => root.unmount())
  host.remove()
})

test('the card has no serious accessibility violations', async () => {
  const run = await show('ana')
  const result = await axe.run(run.host, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  expect(
    result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  ).toEqual([])
  await run.unmount()
})
