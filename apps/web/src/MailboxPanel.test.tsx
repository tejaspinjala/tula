import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { MailboxPanel } = await import('./MailboxPanel')
const { LiveEvents } = await import('./live-events')

const roster = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    {
      id: 'heralds',
      name: 'Heralds Hall',
      kind: 'work',
      locked: false,
      captain: { id: 'heralds-captain', name: 'Herald Captain' },
      members: [],
    },
    { id: 'vault', name: 'Vault', kind: 'work', locked: false, captain: null, members: [] },
    { id: 'health', name: 'Health', kind: 'private', locked: true, captain: null, members: [] },
  ],
  next: null,
}
const dossier = (id: string, verified: boolean, failedChecks: string[]) => ({
  id,
  seq: 5,
  subjectQuestId: 'q1',
  subjectHallId: 'heralds',
  requester: { kind: 'guild_master' },
  body: { goal: 'Write the notice', doneCondition: 'Notice filed', met: true },
  verified,
  failedChecks,
  createdAt: '2026-10-20T10:00:00.000Z',
})
const inquiry = {
  seq: 3,
  id: 'i1',
  fromHall: 'heralds',
  toHall: 'health',
  asker: 'm1',
  question: '<i>Where is the key?</i>',
  status: 'answered',
  answer: 'Under the mat.',
  answerQuestId: 'q9',
  askedAt: '2026-10-20T10:00:00.000Z',
}
const report = {
  id: 'b1',
  seq: 2,
  owningHall: 'heralds',
  title: 'Ledger totals drift',
  reproduction: { steps: 'Open the ledger', expected: 'The sum', actual: 'Off by one' },
  status: 'open',
  duplicateOf: null,
  fixQuestId: 'fq1',
  createdAt: '2026-10-20T10:00:00.000Z',
}

const calls: Array<{ url: string; method: string; body: string }> = []
let dossiers = [dossier('d1', false, ['artifact_missing'])]
let refuse: string | null = null

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') })
      if (url.includes('/roster')) {
        return Response.json(roster)
      }
      if (init?.method === 'POST') {
        return refuse
          ? Response.json({ error: refuse }, { status: 422 })
          : Response.json({ ...report, fixQuest: { id: 'fq1' } }, { status: 201 })
      }
      if (url.includes('/inquiries')) {
        return Response.json({ inquiries: [inquiry], next: null })
      }
      if (url.includes('/dossiers') && url.includes('after=5')) {
        return Response.json({ dossiers: [dossier('d0', true, [])], next: null })
      }
      if (url.includes('/dossiers')) {
        return Response.json({ dossiers, next: 5 })
      }
      if (url.includes('/bug-reports')) {
        return Response.json({ reports: [report], next: null })
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

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
async function mount(ui: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(ui)
    await wait()
  })
  return { host, root, unmount: () => act(async () => root.unmount()) }
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label)
async function press(host: HTMLElement, label: string) {
  const b = button(host, label)
  expect(b).toBeDefined()
  await act(async () => {
    b?.click()
    await wait()
  })
}
async function type(host: HTMLElement, name: string, value: string) {
  const el = host.querySelector(`[name="${name}"]`)
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    throw new Error(`no field ${name}`)
  }
  await act(async () => {
    const proto =
      el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('three tabs; Inquiries first, and an Inquiry opens to its question and answer as text', async () => {
  const m = await mount(<MailboxPanel session={session} />)
  const tabs = [...m.host.querySelectorAll('[role="tab"]')].map((t) => t.textContent)
  expect(tabs).toEqual(['Inquiries', 'Dossiers', 'Bug Reports'])
  expect(m.host.querySelector('[data-testid="mail-row"]')?.textContent).toContain('answered')
  await press(m.host, 'Open')
  const detail = m.host.querySelector('[data-testid="mail-detail"]')?.textContent ?? ''
  expect(detail).toContain('<i>Where is the key?</i>')
  expect(detail).toContain('Under the mat.')
  expect(m.host.querySelector('i')).toBeNull()
  await m.unmount()
})

test('a Dossier row says verified or failed; opening it lists the failed checks', async () => {
  const m = await mount(<MailboxPanel session={session} />)
  await press(m.host, 'Dossiers')
  expect(m.host.querySelector('[data-testid="mail-row"]')?.textContent).toContain('Failed')
  await press(m.host, 'Open')
  expect(m.host.querySelector('[data-testid="mail-detail"]')?.textContent).toContain(
    'artifact_missing'
  )
  await m.unmount()
})

test('Dossiers page: older ones load on request', async () => {
  const m = await mount(<MailboxPanel session={session} />)
  await press(m.host, 'Dossiers')
  await press(m.host, 'Load older')
  const rows = m.host.querySelectorAll('[data-testid="mail-row"]')
  expect(rows).toHaveLength(2)
  expect(rows[1]?.textContent).toContain('Verified')
  await m.unmount()
})

test('a Bug Report opens to its reproduction, status and a Fix Quest link', async () => {
  const m = await mount(<MailboxPanel session={session} />)
  await press(m.host, 'Bug Reports')
  await press(m.host, 'Open')
  const detail = m.host.querySelector('[data-testid="mail-detail"]')
  expect(detail?.textContent).toContain('Open the ledger')
  expect(detail?.textContent).toContain('Off by one')
  expect(detail?.textContent).toContain('open')
  expect(detail?.querySelector('a')?.getAttribute('href')).toContain('fq1')
  await m.unmount()
})

test('filing a Bug Report posts it to the selected Hall; a refusal reads as an in-world line', async () => {
  const m = await mount(<MailboxPanel session={session} />)
  await press(m.host, 'Bug Reports')
  await type(m.host, 'bug-title', 'Ledger totals drift')
  await type(m.host, 'bug-steps', 'Open the ledger')
  await type(m.host, 'bug-expected', 'The sum')
  await type(m.host, 'bug-actual', 'Off by one')
  await press(m.host, 'File Bug Report')
  const post = calls.filter((c) => c.method === 'POST').at(-1)
  expect(post?.url).toContain('/bug-reports')
  expect(JSON.parse(post?.body ?? '{}')).toEqual({
    owningHall: 'heralds',
    title: 'Ledger totals drift',
    reproduction: { steps: 'Open the ledger', expected: 'The sum', actual: 'Off by one' },
  })
  expect(m.host.querySelector('[role="status"]')?.textContent).toContain('Fix Quest')
  refuse = 'hall_has_no_owner'
  await press(m.host, 'File Bug Report')
  expect(m.host.querySelector('[role="alert"]')?.textContent).toBe(
    'That Hall has no one to take a Fix Quest.'
  )
  refuse = null
  await m.unmount()
})

test('requesting a Dossier posts the Quest id; a refusal reads as an in-world line', async () => {
  refuse = 'quest_not_finished'
  const m = await mount(<MailboxPanel session={session} />)
  await press(m.host, 'Dossiers')
  await type(m.host, 'dossier-quest', 'q1')
  await press(m.host, 'Request Dossier')
  const post = calls.filter((c) => c.method === 'POST').at(-1)
  expect(post?.url).toContain('/dossiers')
  expect(post?.body).toBe(JSON.stringify({ questId: 'q1' }))
  expect(m.host.querySelector('[role="alert"]')?.textContent).toContain('has not finished yet')
  refuse = null
  await m.unmount()
})

test('a dossier.created event refetches the list live', async () => {
  dossiers = [dossier('d1', false, ['artifact_missing'])]
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <LiveEvents.Provider value={[]}>
        <MailboxPanel session={session} />
      </LiveEvents.Provider>
    )
    await wait()
  })
  await press(host, 'Dossiers')
  expect(host.querySelectorAll('[data-testid="mail-row"]')).toHaveLength(1)
  dossiers = [dossier('d2', true, []), ...dossiers]
  const event = {
    seq: 9,
    type: 'dossier.created',
    payload: { dossierId: 'd2' },
    occurredAt: '2026-10-20T10:00:00.000Z',
  }
  await act(async () => {
    root.render(
      <LiveEvents.Provider value={[event]}>
        <MailboxPanel session={session} />
      </LiveEvents.Provider>
    )
    await wait()
  })
  expect(host.querySelectorAll('[data-testid="mail-row"]')).toHaveLength(2)
  await act(async () => root.unmount())
})

test('signed out, it asks for a passkey and reads nothing', async () => {
  calls.length = 0
  const m = await mount(<MailboxPanel session={null} />)
  expect(m.host.textContent).toContain('Sign in')
  expect(calls).toEqual([])
  await m.unmount()
})

test('the tabs come before the list; opening a row shows its detail as its own section with a Back control', async () => {
  const m = await mount(<MailboxPanel session={session} />)
  const tablist = m.host.querySelector('[role="tablist"]')
  const list = m.host.querySelector('ul[aria-label="Inquiries"]')
  expect(tablist && list && tablist.compareDocumentPosition(list) & 4).toBeTruthy()
  await press(m.host, 'Open')
  const detail = m.host.querySelector('[data-testid="mail-detail"]')
  expect(detail?.closest('li')).toBeNull()
  expect(detail?.textContent).toContain('Under the mat.')
  expect(m.host.querySelector('ul[aria-label="Inquiries"]')).toBeNull()
  await press(m.host, 'Back to the list')
  expect(m.host.querySelector('[data-testid="mail-detail"]')).toBeNull()
  expect(m.host.querySelectorAll('[data-testid="mail-row"]')).toHaveLength(1)
  await m.unmount()
})

test('?hall=<id> starts the Mailbox on that Hall', async () => {
  window.history.replaceState({}, '', '/mailbox?hall=vault')
  calls.length = 0
  const m = await mount(<MailboxPanel session={session} />)
  const select = m.host.querySelector<HTMLSelectElement>('#mailbox-hall')
  expect(select?.value).toBe('vault')
  window.history.replaceState({}, '', '/')
  await m.unmount()
})
