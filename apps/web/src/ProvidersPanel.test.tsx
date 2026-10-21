import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { ProvidersPanel } = await import('./ProvidersPanel')

let hosted = true

const config = {
  steward: { id: 's', name: 'S' },
  halls: [],
  providers: [
    { id: 'home', auth: 'subscription', privateEligible: false },
    { id: 'key', auth: 'api_key', privateEligible: true },
  ],
}

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request) => {
      const path = String(url)
      if (path.endsWith('/providers/status')) {
        return Response.json({ hosted, vendor: 'Anthropic' })
      }
      return Response.json({ version: 1, config })
    },
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

async function text() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<ProvidersPanel session={session} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const found = host.textContent ?? ''
  await act(async () => root.unmount())
  return found
}

test('the panel takes hosted and the vendor from the server, and words each row by its state', async () => {
  hosted = true
  const onHosted = await text()
  expect(onHosted).toContain('not available on a hosted Guildhall')
  expect(onHosted).toContain("Private Quests will be sent to Anthropic's API with your API key.")
  hosted = false
  const onMac = await text()
  expect(onMac).toContain(
    'Private Quests would be sent to Anthropic through your Claude subscription on this Mac.'
  )
})
