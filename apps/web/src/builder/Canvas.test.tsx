import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { BuilderConfig } from './model'

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { Canvas } = await import('./Canvas')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  Reflect.set(
    globalThis,
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const config: BuilderConfig = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    {
      id: 'heralds',
      name: 'Heralds Hall',
      kind: 'work',
      locked: false,
      privateEligible: false,
      captain: { id: 'heralds-captain', name: 'Captain' },
      members: [{ id: 'm1', name: 'Quill', rank: 'apprentice' }],
    },
  ],
  sealPolicy: 'always',
}

test('a selected Hall stays under its Captain and Members so they can still be dragged', async () => {
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Canvas
        config={config}
        overlays={{ pausedHalls: new Set(), claimed: new Map(), barred: false }}
        issues={new Map()}
        selected="heralds"
        onSelect={() => undefined}
        onMove={() => undefined}
        onDropPiece={() => undefined}
      />
    )
  })
  const zOf = (id: string) => {
    const el = host.querySelector(`.react-flow__node[data-id="${id}"]`)
    return Number((el as HTMLElement | null)?.style.zIndex)
  }
  expect(zOf('heralds')).toBeLessThan(zOf('heralds-captain'))
  expect(zOf('heralds')).toBeLessThan(zOf('m1'))
  await act(async () => root.unmount())
})
