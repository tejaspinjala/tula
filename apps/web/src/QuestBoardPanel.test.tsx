import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { QuestBoardPanel } = await import('./QuestBoardPanel')
const { roundText } = await import('./quests')

const posts: unknown[] = []
const quest = {
  id: 'q1',
  title: 'Queued thing',
  hallId: 'heralds',
  ownerId: 'm',
  state: 'queued',
  doneCondition: 'd',
  round: 0,
  roundLimit: 2,
  attempts: 0,
  lastError: null,
}

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/quests') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Response.json({ ...quest, id: 'q2' }, { status: 201 })
      }
      if (url.includes('/quests')) {
        return Response.json({ quests: [quest], next: null })
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

test('a Quest that has not started reads Round 1 of its limit, never Round 0', () => {
  expect(roundText({ round: 0, roundLimit: 2 })).toBe('Round 1 of 2')
  expect(roundText({ round: 2, roundLimit: 2 })).toBe('Round 2 of 2')
  expect(roundText({ round: 5, roundLimit: 2 })).toBe('Round 2 of 2')
})

test('the board shows Round 1 of 2 and a form posts a Quest from a Hall and template', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<QuestBoardPanel session={session} />)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(host.textContent).toContain('Round 1 of 2')
  expect(host.textContent).not.toContain('Round 0')
  expect(host.querySelector('h2')?.textContent).not.toBe('Quest Board')

  const title = host.querySelector<HTMLInputElement>('input[name="quest-title"]')
  expect(host.querySelector('select[name="quest-hall"]')).not.toBeNull()
  expect(host.querySelector('select[name="quest-template"]')).not.toBeNull()
  await act(async () => {
    if (title) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        title,
        'Write the brief'
      )
      title.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
  const submit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Post Quest')
  await act(async () => {
    submit?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ templateId: 'herald-brief', title: 'Write the brief' })
  await act(async () => root.unmount())
})
