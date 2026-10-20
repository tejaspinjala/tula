import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { SealPanel } = await import('./SealPanel')
const { parseEvidence, sealStatusLabel } = await import('./seals')

const seal = (status: string) => ({
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

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
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
      if (url.includes('/quests')) {
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
