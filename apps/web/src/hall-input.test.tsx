import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { GameLoader } from './GamePanel'

const inputCalls: boolean[] = []
const noop = () => {}
const loadGame: GameLoader = async () => ({
  startGame: () => ({
    render: noop,
    zoomBy: noop,
    fit: noop,
    teleport: noop,
    goTo: noop,
    setPhase: noop,
    setLook: noop,
    setCouncilState: noop,
    follow: noop,
    setPaused: noop,
    setInputEnabled: (enabled: boolean) => inputCalls.push(enabled),
    destroy: noop,
  }),
})

// react-dom reads the DOM's capabilities when it loads, so the DOM is registered first.
GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { Shell } = await import('./Shell')

const realFetch = globalThis.fetch
const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(async () => Response.json({ error: 'down' }, { status: 503 }), {
    preconnect: realFetch.preconnect,
  })
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

describe('the Hall behind the Bag', () => {
  test('takes no pointer input while a Bag page is open, and takes it again after it closes', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <Shell
          session={session}
          guildName="Ember"
          status="ok"
          onSession={noop}
          loadGame={loadGame}
        />
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const last = () => inputCalls[inputCalls.length - 1]
    expect(last()).toBe(true)
    const press = async () =>
      act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
      })
    await press()
    expect(last()).toBe(false)
    await press()
    expect(last()).toBe(true)
    await act(async () => root.unmount())
    host.remove()
  })
})
