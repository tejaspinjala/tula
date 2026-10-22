import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { GameLoader } from './GamePanel'
import type { HallOptions } from './game/HallScene'

const noop = () => {}
let options: HallOptions | null = null
const loadGame: GameLoader = async () => ({
  startGame: (_parent, given) => {
    options = given
    return {
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
      setInputEnabled: noop,
      destroy: noop,
    }
  },
})

// react-dom reads the DOM's capabilities when it loads, so the DOM is registered first.
GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { GamePanel } = await import('./GamePanel')

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

describe('the location live region', () => {
  test('says the Great Hall to start, and names each room the Guild Master enters', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <GamePanel session={session} navigate={noop} loadGame={loadGame}>
          {() => null}
        </GamePanel>
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const region = () => host.querySelector('[data-testid="game-location"]')
    expect(region()?.getAttribute('aria-live')).toBe('polite')
    expect(region()?.textContent).toBe('You are in the Great Hall.')
    await act(async () => options?.onLocation?.('Research Hall'))
    expect(region()?.textContent).toBe('You are in the Research Hall.')
    await act(async () => options?.onLocation?.('Plaza'))
    expect(region()?.textContent).toBe('You are in the Plaza.')
  })

  test('says why a doorway at hand is barred, and clears it on stepping away', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <GamePanel session={session} navigate={noop} loadGame={loadGame}>
          {() => null}
        </GamePanel>
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    const notice = () => host.querySelector('[data-testid="game-notice"]')?.textContent
    await act(async () => options?.onNotice?.('Health is locked. Unlock it from the Hall builder.'))
    expect(notice()).toBe('Health is locked. Unlock it from the Hall builder.')
    await act(async () => options?.onNotice?.(''))
    expect(notice()).toBe('')
  })
})
