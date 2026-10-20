import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { Canvas, NODE_PIECE } = await import('./Canvas')

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

const graph = { nodes: [{ id: 'start', type: 'trigger.manual' as const }], edges: [] }

test('a palette piece dropped onto an existing node still adds a node', async () => {
  const dropped: string[] = []
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Canvas
        graph={graph}
        places={new Map([['start', { x: 0, y: 0 }]])}
        issues={new Map()}
        overlay={new Map()}
        selected={null}
        readOnly={false}
        onSelect={() => undefined}
        onConnect={() => undefined}
        onMove={() => undefined}
        onDropType={(type) => dropped.push(type)}
      />
    )
  })
  const node = host.querySelector('.react-flow__node')
  expect(node).not.toBeNull()
  const data = new DataTransfer()
  data.setData(NODE_PIECE, 'verify')
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  await act(async () => {
    node?.dispatchEvent(event)
  })
  expect(dropped).toEqual(['verify'])
})
