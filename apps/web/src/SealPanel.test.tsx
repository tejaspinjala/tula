import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { SealPanel } = await import('./SealPanel')
const { parseEvidence, sealStatusLabel } = await import('./seals')

let payloadTitle: string | null | undefined
let questsDown = false
let holdReauth: Promise<void> | null = null
const seal = (status: string) => ({
  ...(payloadTitle === undefined ? {} : { questTitle: payloadTitle }),
  id: '22222222-2222-4222-8222-222222222222',
  questId: 'q1',
  requestedBy: 'm',
  kind: 'post',
  text: 'Hello world',
  evidence: 'Verdict passed: length (within the limit); banned_terms (none)',
  actionHash: 'h'.repeat(64),
  stale: false,
  status,
  requestedAt: '2026-03-01T00:00:00.000Z',
  expiresAt: '2026-03-02T00:00:00.000Z',
  decidedAt: null,
  decisionNote: null,
})
let status = 'requested'
const posted: unknown[] = []
const reauths: string[] = []

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/session/reauth/begin')) {
        reauths.push(url)
        await holdReauth
      }
      if (url.includes('/seals/') && url.endsWith('/posted')) {
        posted.push(init?.body)
        return Response.json(seal('consumed'))
      }
      if (url.includes('/seals?')) {
        return Response.json({
          seals: url.includes(`status=${status}`) ? [seal(status)] : [],
          next: null,
        })
      }
      if (url.includes('/quests') && !questsDown) {
        return Response.json({
          quests: [
            {
              id: 'q1',
              title: 'Announce run check',
              hallId: 'heralds',
              ownerId: 'm',
              state: 'awaiting_seal',
              doneCondition: 'd',
              round: 1,
              roundLimit: 2,
              attempts: 1,
              lastError: null,
            },
          ],
          next: null,
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

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<SealPanel session={session} />)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  return { host, root }
}

const labels = (host: HTMLElement) =>
  [...host.querySelectorAll('button')].map((b) => b.textContent?.trim())

test('evidence splits into a lead and a list of checks', () => {
  expect(parseEvidence('Verdict passed: length (ok); banned_terms (none)')).toEqual({
    lead: 'Verdict passed',
    items: ['length (ok)', 'banned_terms (none)'],
  })
  expect(parseEvidence('just a sentence')).toEqual({ lead: null, items: ['just a sentence'] })
})

test('the Council of Elders votes list as evidence items after the Verdict', () => {
  expect(
    parseEvidence(
      'Verdict passed: length (ok); Council of Elders did not approve (block); architect approve - fits; skeptic block - too bold; ops abstain (failed)'
    )
  ).toEqual({
    lead: 'Verdict passed',
    items: [
      'length (ok)',
      'Council of Elders did not approve (block)',
      'architect approve - fits',
      'skeptic block - too bold',
      'ops abstain (failed)',
    ],
  })
})

test('a consumed Seal reads posted', () => {
  expect(sealStatusLabel('consumed')).toBe('posted')
  expect(sealStatusLabel('requested')).toBe('requested')
})

test('the inbox loads by itself and each Seal card names its Quest, with evidence as a list', async () => {
  status = 'requested'
  const { host, root } = await mount()
  expect(labels(host)).not.toContain('Load Seals')
  expect(host.textContent).toContain('Hello world')
  expect(host.textContent).toContain('Announce run check')
  const items = [...host.querySelectorAll('ul[aria-label="Evidence"] li')].map((li) =>
    li.textContent?.trim()
  )
  expect(items).toEqual(['length (within the limit)', 'banned_terms (none)'])
  await act(async () => root.unmount())
})

test('Stamp comes before Deny with note', async () => {
  status = 'requested'
  const { host, root } = await mount()
  const names = labels(host)
  expect(names.indexOf('Stamp with passkey')).toBeGreaterThan(-1)
  expect(names.indexOf('Stamp with passkey')).toBeLessThan(names.indexOf('Deny with note'))
  await act(async () => root.unmount())
})

test('Mark posted asks for confirmation and an optional post URL before it posts', async () => {
  status = 'approved'
  posted.length = 0
  const { host, root } = await mount()
  const mark = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Mark posted')
  await act(async () => {
    mark?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(posted).toEqual([])
  expect(host.querySelector('input[name="post-url"]')).not.toBeNull()
  const confirm = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === 'Confirm: I posted this'
  )
  await act(async () => {
    confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(posted).toHaveLength(1)
  await act(async () => root.unmount())
  status = 'requested'
})

const press = async (target: Element | null | undefined, key: string) => {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}
const cursor = (host: HTMLElement) =>
  host.querySelector('[role="option"][aria-selected="true"]') as HTMLElement | null

test('Stamp asks Yes or No naming the Quest, and the cursor starts on No', async () => {
  status = 'requested'
  reauths.length = 0
  const { host, root } = await mount()
  await click(host, 'Stamp with passkey')
  expect(host.querySelector('.px-yesno')?.textContent).toContain('Announce run check')
  expect(cursor(host)?.textContent).toBe('No')
  await act(async () => root.unmount())
})

test('a single Enter from the default cursor never grants a Seal', async () => {
  status = 'requested'
  reauths.length = 0
  const { host, root } = await mount()
  await click(host, 'Stamp with passkey')
  await press(cursor(host), 'Enter')
  expect(reauths).toEqual([])
  expect(host.querySelector('.px-yesno')).toBeNull()
  expect(labels(host)).toContain('Stamp with passkey')
  await act(async () => root.unmount())
})

test('answering Yes to the Stamp prompt asks for the passkey; Deny asks first too', async () => {
  status = 'requested'
  reauths.length = 0
  const { host, root } = await mount()
  await click(host, 'Stamp with passkey')
  await press(cursor(host), 'y')
  expect(reauths).toHaveLength(1)
  await click(host, 'Deny with note')
  expect(host.querySelector('.px-yesno')?.textContent).toContain('Refuse')
  await press(cursor(host), 'Enter')
  expect(reauths).toHaveLength(1)
  await act(async () => root.unmount())
})

test('a guild with no Seal waiting gets an in-world line and a refresh action', async () => {
  status = 'none'
  const { host, root } = await mount()
  expect(host.querySelector('.px-empty')?.textContent).toContain('No Seal is waiting')
  expect(labels(host)).toContain('▶Look again')
  await act(async () => root.unmount())
  status = 'requested'
})

test('a Seal card shows the Quest title from the Seal payload, with no Quest list needed', async () => {
  status = 'requested'
  payloadTitle = 'Payload title'
  questsDown = true
  const { host, root } = await mount()
  expect(host.textContent).toContain('Seal for Payload title')
  expect(host.textContent).toContain('Quest: Payload title')
  await act(async () => root.unmount())
  payloadTitle = undefined
  questsDown = false
})

test('a Seal without a Quest title reads Untitled Quest, never an id', async () => {
  status = 'requested'
  payloadTitle = null
  questsDown = true
  const { host, root } = await mount()
  expect(host.textContent).toContain('Seal for Untitled Quest')
  expect(host.textContent).not.toContain('q1')
  await act(async () => root.unmount())
  payloadTitle = undefined
  questsDown = false
})

test('Deny settles the Seal at once, and a failed Deny rolls it back with a message', async () => {
  status = 'requested'
  let release: () => void = () => undefined
  holdReauth = new Promise<void>((resolve) => {
    release = resolve
  })
  const { host, root } = await mount()
  await click(host, 'Deny with note')
  await press(cursor(host), 'y')
  expect(host.textContent).toContain('denied')
  expect(labels(host)).not.toContain('Deny with note')
  await act(async () => {
    release()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  holdReauth = null
  expect(labels(host)).toContain('Deny with note')
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Deny failed')
  await act(async () => root.unmount())
})
