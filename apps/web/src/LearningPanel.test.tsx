import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch
const suggestion = (id: string, url: string) => ({
  id,
  sourceId: `pr:o/r#${id}`,
  repo: 'o/r',
  kind: 'pr',
  title: `change ${id}`,
  body: 'why',
  url,
  status: 'pending',
  noteId: null,
})

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { LearningPanel } = await import('./LearningPanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        suggestions: [
          suggestion('1', 'javascript:alert(1)'),
          suggestion('2', 'https://evil.example/github.com/x'),
          suggestion('3', 'https://github.com/o/r/pull/3'),
        ],
        next: null,
      }),
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

test('only an https github.com url becomes a link', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<LearningPanel session={session} />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const links = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  expect(links).toEqual(['https://github.com/o/r/pull/3'])
  expect(host.textContent).toContain('change 1')
  await act(async () => root.unmount())
})
