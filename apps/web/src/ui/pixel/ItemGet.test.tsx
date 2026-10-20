import { afterAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { ItemGet } = await import('./ItemGet')
const { mount, setReducedMotion } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => setReducedMotion(false))

test('a good event is a polite status with the noun picked out', async () => {
  const m = await mount(<ItemGet noun="Renown" verb="Earned 50" />)
  const banner = m.host.querySelector('[role="status"]')
  expect(banner).not.toBeNull()
  expect(m.host.querySelector('[role="alert"]')).toBeNull()
  expect(banner?.textContent).toContain('Earned 50 Renown!')
  expect(banner?.querySelector('.px-itemget-noun')?.textContent).toBe('Renown')
  await m.unmount()
})

test('a danger event is an alert in a red frame', async () => {
  const m = await mount(<ItemGet danger noun="Gates" verb="Barred the" />)
  const banner = m.host.querySelector('[role="alert"]')
  expect(banner).not.toBeNull()
  expect(m.host.querySelector('[role="status"]')).toBeNull()
  expect(banner?.getAttribute('data-danger')).toBe('true')
  await m.unmount()
})

test('it slides in, unless motion is reduced', async () => {
  const sliding = await mount(<ItemGet noun="Seal" verb="Granted a" />)
  expect(sliding.host.querySelector('.px-itemget')?.getAttribute('data-motion')).toBe('slide')
  await sliding.unmount()
  setReducedMotion(true)
  const still = await mount(<ItemGet noun="Seal" verb="Granted a" />)
  expect(still.host.querySelector('.px-itemget')?.getAttribute('data-motion')).toBe('none')
  await still.unmount()
})
