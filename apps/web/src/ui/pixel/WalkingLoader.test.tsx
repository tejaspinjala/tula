import { afterAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { WalkingLoader } = await import('./WalkingLoader')
const { mount, setReducedMotion } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => setReducedMotion(false))

test('it is a status that says the Member is travelling', async () => {
  const m = await mount(<WalkingLoader />)
  const status = m.host.querySelector('[role="status"]')
  expect(status?.textContent).toContain('Travelling')
  expect(m.host.querySelector('.px-walker')?.getAttribute('aria-hidden')).toBe('true')
  await m.unmount()
})

test('it walks in place, but stands still under reduced motion', async () => {
  const walking = await mount(<WalkingLoader />)
  expect(walking.host.querySelector('.px-walker')?.getAttribute('data-animated')).toBe('true')
  await walking.unmount()
  setReducedMotion(true)
  const still = await mount(<WalkingLoader />)
  expect(still.host.querySelector('.px-walker')?.getAttribute('data-animated')).toBe('false')
  await still.unmount()
})

test('a custom line replaces the default', async () => {
  const m = await mount(<WalkingLoader label="Fetching the Ledger of Deeds" />)
  expect(m.host.textContent).toContain('Fetching the Ledger of Deeds')
  await m.unmount()
})
