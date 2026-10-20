import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { Tooltip } = await import('./Tooltip')
const { mount, hover, focus, press } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function show() {
  const m = await mount(
    <Tooltip
      name="Silver Quill"
      category="Tool"
      stats={[
        { label: 'Cost', value: '3 Crowns' },
        { label: 'Uses', value: '12' },
      ]}
    >
      {(describedBy) => (
        <button type="button" aria-describedby={describedBy}>
          Quill
        </button>
      )}
    </Tooltip>
  )
  const trigger = m.host.querySelector('button')
  if (!trigger) {
    throw new Error('no trigger')
  }
  const tip = () => m.host.querySelector('[role="tooltip"]')
  return { m, trigger, tip }
}

test('the tooltip is closed until asked for', async () => {
  const { m, tip } = await show()
  expect(tip()).toBeNull()
  await m.unmount()
})

test('hover opens it with the name, category and stat rows', async () => {
  const { m, trigger, tip } = await show()
  await hover(trigger)
  expect(tip()?.textContent).toContain('Silver Quill')
  expect(tip()?.textContent).toContain('Tool')
  expect(tip()?.textContent).toContain('Cost')
  expect(tip()?.textContent).toContain('3 Crowns')
  await m.unmount()
})

test('keyboard focus opens it too, and the trigger is described by it', async () => {
  const { m, trigger, tip } = await show()
  expect(trigger.getAttribute('aria-describedby')).toBeNull()
  await focus(trigger)
  const open = tip()
  expect(open).not.toBeNull()
  expect(trigger.getAttribute('aria-describedby')).toBe(open?.id ?? 'missing')
  await m.unmount()
})

test('Esc dismisses it', async () => {
  const { m, trigger, tip } = await show()
  await focus(trigger)
  expect(tip()).not.toBeNull()
  await press(trigger, 'Escape')
  expect(tip()).toBeNull()
  await m.unmount()
})
