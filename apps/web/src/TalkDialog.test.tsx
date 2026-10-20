import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import axe from 'axe-core'
import { act, useReducer } from 'react'
import { initialTalk, type TalkState, type Target, talkReducer } from './game/interact'
import type { SceneState } from './game/scene'

let dismissals = 0
const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const ana: Target = { kind: 'member', id: 'ana' }
const desk: Target = { kind: 'sealDesk' }
const scene: SceneState = {
  rooms: [
    {
      hallId: 'heralds',
      name: 'Heralds',
      locked: false,
      paused: false,
      memberIds: ['ana'],
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
  },
  stewardId: 'steward',
  scrolls: [{ questId: 'q2', title: 'Announce the launch' }],
  apprentices: [],
  campaigns: [],
  gateClosed: false,
  coinsCents: 0,
  appliedSeq: 5,
}
const quests = [
  { id: 'q1', title: 'Draft the brief', hallId: 'heralds', ownerId: 'ana', state: 'active' },
]

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { TalkDialog } = await import('./TalkDialog')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

interface Run {
  host: HTMLElement
  paths: string[]
  calls: { url: string; init: RequestInit | undefined }[]
  states: TalkState[]
  unmount: () => Promise<void>
}

async function show(
  target: Target,
  reply: Response = Response.json({ id: 'q9' }, { status: 201 })
) {
  const paths: string[] = []
  const calls: Run['calls'] = []
  const states: TalkState[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return reply.clone()
  }
  function Harness() {
    const [state, dispatch] = useReducer(talkReducer, {
      ...initialTalk,
      near: target,
      open: target,
    })
    states.push(state)
    return (
      <TalkDialog
        session={session}
        fetcher={fetcher}
        state={state}
        dispatch={dispatch}
        scene={scene}
        quests={quests}
        navigate={(p) => paths.push(p)}
        onDismiss={() => {
          dismissals += 1
        }}
      />
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<Harness />)
  })
  const run: Run = {
    host,
    paths,
    calls,
    states,
    unmount: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
  return run
}

const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)

async function click(host: HTMLElement, name: string) {
  const b = button(host, name)
  expect(b).toBeDefined()
  await act(async () => {
    b?.click()
  })
}

async function violations(host: HTMLElement): Promise<string[]> {
  const result = await axe.run(host, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
}

test('a Member dialog is a real labelled modal showing who they are and their Quest', async () => {
  const run = await show(ana)
  const dialog = run.host.querySelector('dialog')
  expect(dialog?.open).toBe(true)
  const labelId = dialog?.getAttribute('aria-labelledby') ?? ''
  expect(run.host.querySelector(`#${labelId}`)?.textContent).toBe('Ana')
  const text = dialog?.textContent ?? ''
  expect(text).toContain('journeyman')
  expect(text).toContain('Heralds Hall')
  expect(text).toContain('Draft the brief')
  expect(text).toContain('active')
  expect(text).toContain('Recent messages')
  expect(text).toContain('No messages yet')
  expect(await violations(run.host)).toEqual([])
  await run.unmount()
})

test('Esc hands focus back to the world, but a dialog closed by the program does not', async () => {
  const run = await show(ana)
  const dialog = run.host.querySelector('dialog')
  const before = dismissals
  await act(async () => {
    dialog?.dispatchEvent(new Event('cancel', { cancelable: true }))
  })
  expect(dismissals).toBe(before + 1)
  await act(async () => {
    dialog?.close()
  })
  expect(dismissals).toBe(before + 1)
  await run.unmount()
})

test('Esc closes the dialog', async () => {
  const run = await show(ana)
  const dialog = run.host.querySelector('dialog')
  await act(async () => {
    dialog?.close()
  })
  expect(run.states.at(-1)?.open).toBeNull()
  await run.unmount()
})

test('Open in ledger goes to the roster and closes the dialog', async () => {
  const run = await show(ana)
  await click(run.host, 'Open in ledger')
  expect(run.paths).toEqual(['/roster'])
  expect(run.states.at(-1)?.open).toBeNull()
  await run.unmount()
})

test('Assign a Quest posts to the governed route with the Member as owner and says so', async () => {
  const run = await show(ana)
  await click(run.host, 'Assign a Quest')
  const title = run.host.querySelector('input')
  expect(title).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(title, 'Write the launch post')
    title?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(await violations(run.host)).toEqual([])
  await click(run.host, 'Post Quest')
  const posts = run.calls.filter((c) => c.init?.method === 'POST')
  expect(posts).toHaveLength(1)
  expect(posts[0]?.url).toBe(`/api/guilds/${session.guildId}/quests`)
  const sent = JSON.parse(String(posts[0]?.init?.body))
  expect(sent).toMatchObject({
    templateId: 'herald-brief',
    title: 'Write the launch post',
    ownerId: 'ana',
  })
  expect(typeof sent.jobKey).toBe('string')
  expect(run.host.querySelector('[role="status"]')?.textContent).toContain('posted')
  await click(run.host, 'Open Quest Board')
  expect(run.paths).toEqual(['/quests'])
  await run.unmount()
})

test('a refusal is shown and nothing else is posted', async () => {
  const run = await show(ana, Response.json({ error: 'hall_paused' }, { status: 422 }))
  await click(run.host, 'Assign a Quest')
  const title = run.host.querySelector('input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(title, 'Anything')
    title?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click(run.host, 'Post Quest')
  expect(run.host.querySelector('[role="alert"]')?.textContent).toContain('paused')
  expect(run.calls.filter((c) => c.init?.method === 'POST')).toHaveLength(1)
  await run.unmount()
})

test('the Seal desk dialog lists waiting Seals and Review Seal opens the Seal inbox', async () => {
  const run = await show(desk)
  const dialog = run.host.querySelector('dialog')
  expect(dialog?.open).toBe(true)
  expect(dialog?.textContent).toContain('Announce the launch')
  expect(await violations(run.host)).toEqual([])
  await click(run.host, 'Review Seal')
  expect(run.paths).toEqual(['/seals'])
  expect(run.calls).toHaveLength(0)
  await run.unmount()
})

const exchange = {
  missives: [
    {
      id: 'm2',
      from: 'ana',
      to: 'bo',
      text: 'On it, drafting now.',
      sentAt: '2026-01-01T00:02:00.000Z',
    },
    {
      id: 'm1',
      from: 'bo',
      to: 'ana',
      text: '<img src=x onerror=alert(1)> please draft the brief',
      sentAt: '2026-01-01T00:01:00.000Z',
    },
    {
      id: 'm0',
      from: 'bo',
      to: 'cy',
      text: 'a note for someone else',
      sentAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  next: null,
}

test('a Member dialog lists the Missives they sent and received, newest first, as plain text', async () => {
  const run = await show(ana, Response.json(exchange))
  expect(run.calls[0]?.url).toBe(`/api/guilds/${session.guildId}/halls/heralds/missives?limit=50`)
  const dialog = run.host.querySelector('dialog')
  const items = [...(dialog?.querySelectorAll('[data-testid="missive"]') ?? [])].map(
    (li) => li.textContent ?? ''
  )
  expect(items).toHaveLength(2)
  expect(items[0]).toContain('Ana')
  expect(items[0]).toContain('On it, drafting now.')
  expect(items[1]).toContain('<img src=x onerror=alert(1)> please draft the brief')
  expect(dialog?.querySelector('img')).toBeNull()
  expect(dialog?.textContent).not.toContain('a note for someone else')
  expect(dialog?.textContent).not.toContain('No messages yet')
  expect(await violations(run.host)).toEqual([])
  await run.unmount()
})

test('a Member with no Missives, or a failed read, still says there are none', async () => {
  const none = await show(ana, Response.json({ missives: [], next: null }))
  expect(none.host.textContent).toContain('No messages yet')
  await none.unmount()
  const failed = await show(ana, Response.json({ error: 'unauthenticated' }, { status: 401 }))
  expect(failed.host.textContent).toContain('No messages yet')
  await failed.unmount()
})
