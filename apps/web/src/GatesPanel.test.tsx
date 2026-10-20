import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { GatesPanel } = await import('./GatesPanel')

let operator = false

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async () => Response.json({ guild: false, global: false, operator }),
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

async function labels() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<GatesPanel session={session} />)
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  const found = [...host.querySelectorAll('button')].map((b) => b.textContent)
  await act(async () => root.unmount())
  return found
}

test('the global bar and lift are shown to platform operators only', async () => {
  operator = false
  const guildOnly = await labels()
  expect(guildOnly).toContain('Bar this guild')
  expect(guildOnly.join(' ')).not.toContain('every guild')
  expect(guildOnly.join(' ')).not.toContain('global')
  operator = true
  const all = await labels()
  expect(all).toContain('Bar every guild')
  expect(all).toContain('Lift the global bar with passkey')
})
