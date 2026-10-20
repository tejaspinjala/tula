import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'

GlobalRegistrator.register()
const { createRoot } = await import('react-dom/client')
const { Inspector } = await import('./Inspector')

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const graph: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'seal', type: 'approval', of: '' },
    { id: 'post', type: 'post', of: 'seal' },
  ],
  edges: [],
}

test('the Confirm delete / Keep state resets when another node is selected', async () => {
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = createRoot(host)
  const render = (selected: string) =>
    act(async () => {
      root.render(
        <Inspector
          graph={graph}
          selected={selected}
          halls={[]}
          onChange={() => {}}
          onSelect={() => {}}
        />
      )
    })
  await render('seal')
  const del = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Delete node')
  await act(async () => {
    del?.click()
  })
  expect(host.textContent).toContain('Confirm delete')
  await render('post')
  expect(host.textContent).not.toContain('Confirm delete')
  expect(host.textContent).toContain('Delete node')
})

test('the "Judges the output of" picker does not offer or show a node that no longer exists', async () => {
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = createRoot(host)
  const dangling: WorkflowGraph = {
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      { id: 'seal', type: 'approval', of: 'verify' },
    ],
    edges: [],
  }
  await act(async () => {
    root.render(
      <Inspector
        graph={dangling}
        selected="seal"
        halls={[]}
        onChange={() => {}}
        onSelect={() => {}}
      />
    )
  })
  const select = host.querySelector('select[aria-label="Judges the output of"]')
  const options = [...(select?.querySelectorAll('option') ?? [])].map((o) => o.textContent)
  expect(options).not.toContain('verify')
  expect(options).toContain('Choose a node')
})
