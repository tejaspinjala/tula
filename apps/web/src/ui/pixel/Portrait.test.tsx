import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { Portrait } = await import('./Portrait')
const { mount } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('a Member portrait is an image named after the Member', async () => {
  const m = await mount(<Portrait name="Ana" />)
  const img = m.host.querySelector('[role="img"]')
  expect(img?.getAttribute('aria-label')).toBe('Ana')
  await m.unmount()
})

test('the same name always gets the same look and the look can change expression', async () => {
  const a = await mount(<Portrait name="Ana" />)
  const b = await mount(<Portrait name="Ana" mood="worried" />)
  const hue = (host: HTMLElement) => host.querySelector('.px-portrait')?.getAttribute('data-hue')
  expect(hue(a.host)).toBe(hue(b.host))
  expect(a.host.querySelector('.px-portrait')?.getAttribute('data-mood')).toBe('neutral')
  expect(b.host.querySelector('.px-portrait')?.getAttribute('data-mood')).toBe('worried')
  await a.unmount()
  await b.unmount()
})

test('a paused or errored Member is greyed with an icon and a word, never colour alone', async () => {
  const paused = await mount(<Portrait name="Ana" state="paused" />)
  expect(paused.host.querySelector('.px-portrait')?.getAttribute('data-state')).toBe('paused')
  expect(paused.host.textContent).toContain('Paused')
  expect(paused.host.querySelector('.px-portrait-icon')?.getAttribute('aria-hidden')).toBe('true')
  expect(paused.host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ana, paused')
  await paused.unmount()
  const errored = await mount(<Portrait name="Ana" state="error" />)
  expect(errored.host.textContent).toContain('Trouble')
  await errored.unmount()
})
