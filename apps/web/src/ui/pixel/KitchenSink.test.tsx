import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { KitchenSink, isKitchenSinkPath } = await import('./KitchenSink')
const { mount } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('the kitchen sink route exists in development only', () => {
  expect(isKitchenSinkPath('/kitchen-sink', true)).toBe(true)
  expect(isKitchenSinkPath('/kitchen-sink/', true)).toBe(true)
  expect(isKitchenSinkPath('/kitchen-sink', false)).toBe(false)
  expect(isKitchenSinkPath('/quests', true)).toBe(false)
})

test('it shows every component of the kit', async () => {
  const m = await mount(<KitchenSink />)
  const has = (selector: string) => m.host.querySelector(selector) !== null
  expect(has('.px-frame[data-variant="wood"]')).toBe(true)
  expect(has('.px-frame[data-variant="paper"]')).toBe(true)
  expect(has('.px-frame[data-variant="dialog"]')).toBe(true)
  expect(has('.px-frame[data-variant="slot"]')).toBe(true)
  expect(has('.px-btn')).toBe(true)
  expect(has('.px-btn[data-danger="true"]')).toBe(true)
  expect(has('.px-dialogue')).toBe(true)
  expect(has('.px-menu')).toBe(true)
  expect(has('.px-yesno')).toBe(true)
  expect(has('meter')).toBe(true)
  expect(has('.px-itemget')).toBe(true)
  expect(has('[role="alert"].px-itemget')).toBe(true)
  expect(has('.px-slotgrid')).toBe(true)
  expect(has('.px-portrait')).toBe(true)
  expect(has('.px-loader')).toBe(true)
  expect(has('.px-empty')).toBe(true)
  expect(has('.px-theme')).toBe(true)
  await m.unmount()
})
