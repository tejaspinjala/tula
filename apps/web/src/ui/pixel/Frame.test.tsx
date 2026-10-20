import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { Frame } = await import('./Frame')
const { mount } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('a frame holds its children and defaults to the wood variant', async () => {
  const m = await mount(<Frame>The Hall</Frame>)
  const frame = m.host.querySelector('.px-frame')
  expect(frame?.textContent).toBe('The Hall')
  expect(frame?.getAttribute('data-variant')).toBe('wood')
  await m.unmount()
})

test('each variant is marked for the stylesheet', async () => {
  const seen: (string | null | undefined)[] = []
  for (const variant of ['wood', 'paper', 'dialog', 'slot'] as const) {
    const m = await mount(<Frame variant={variant}>x</Frame>)
    seen.push(m.host.querySelector('.px-frame')?.getAttribute('data-variant'))
    await m.unmount()
  }
  expect(seen).toEqual(['wood', 'paper', 'dialog', 'slot'])
})

test('a caller class is added next to the frame class', async () => {
  const m = await mount(<Frame className="board">x</Frame>)
  expect(m.host.querySelector('.px-frame.board')).not.toBeNull()
  await m.unmount()
})
