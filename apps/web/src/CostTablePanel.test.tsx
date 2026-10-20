import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { CostTablePanel } = await import('./CostTablePanel')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/cost-per-post')) {
        return Response.json({
          overall: { posts: 2, costMicros: 0, costPerPostMicros: 0 },
          campaigns: [{ campaignId: 'c1', posts: 2, costMicros: 0, costPerPostMicros: 0 }],
          next: null,
        })
      }
      if (url.includes('/costs')) {
        return Response.json({
          rows: [
            {
              key: 'a'.repeat(64),
              calls: 1,
              inputTokens: 1,
              outputTokens: 1,
              costMicros: 0,
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

test('cost tables scroll inside their own container, and unmetered spend says so (B7, U8)', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<CostTablePanel session={session} />)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  const tables = [...host.querySelectorAll('table')]
  expect(tables.length).toBe(2)
  for (const table of tables) {
    expect(table.parentElement?.className).toContain('table-scroll')
  }
  expect(host.textContent).toContain('unmetered (subscription)')
  await act(async () => root.unmount())
})
