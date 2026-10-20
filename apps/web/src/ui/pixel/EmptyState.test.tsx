import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { EmptyState } = await import('./EmptyState')
const { mount, click } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('it shows a Member and one in-world line', async () => {
  const m = await mount(<EmptyState member="Ana" line="The Quest Board is empty." />)
  expect(m.host.textContent).toContain('The Quest Board is empty.')
  expect(m.host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Ana')
  expect(m.host.querySelector('button')).toBeNull()
  await m.unmount()
})

test('its action is a real button that runs the action', async () => {
  let posted = 0
  const m = await mount(
    <EmptyState
      member="Ana"
      line="The Quest Board is empty."
      actionLabel="Post a Quest?"
      onAction={() => posted++}
    />
  )
  const button = m.host.querySelector('button')
  expect(button?.textContent).toContain('Post a Quest?')
  if (button) {
    await click(button)
  }
  expect(posted).toBe(1)
  await m.unmount()
})
