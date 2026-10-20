import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { SlotGrid } = await import('./SlotGrid')
const { mount, press, click } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const slots = [
  { id: 'quill', label: 'Silver Quill', count: 3 },
  { id: 'scroll', label: 'Scroll', count: 12 },
  { id: 'key', label: 'Gate Key' },
  { id: 'lamp', label: 'Lamp' },
]

async function show() {
  const chosen: string[] = []
  const m = await mount(
    <SlotGrid label="Satchel" slots={slots} columns={2} onSelect={(id) => chosen.push(id)} />
  )
  const options = () => [...m.host.querySelectorAll<HTMLElement>('[role="option"]')]
  const selected = () => options().findIndex((o) => o.getAttribute('aria-selected') === 'true')
  return { m, chosen, options, selected }
}

test('each slot is named, shows its count and one slot is in the tab order', async () => {
  const { m, options } = await show()
  expect(options().map((o) => o.getAttribute('aria-label'))).toEqual([
    'Silver Quill, 3',
    'Scroll, 12',
    'Gate Key',
    'Lamp',
  ])
  expect(options()[0]?.querySelector('.px-slot-count')?.textContent).toBe('3')
  expect(options().map((o) => o.tabIndex)).toEqual([0, -1, -1, -1])
  await m.unmount()
})

test('arrows move across and down the grid and Enter selects', async () => {
  const { m, chosen, options, selected } = await show()
  const first = options()[0]
  if (!first) {
    throw new Error('no slot')
  }
  await press(first, 'ArrowRight')
  expect(selected()).toBe(1)
  const second = options()[1]
  if (!second) {
    throw new Error('no slot')
  }
  await press(second, 'ArrowDown')
  expect(selected()).toBe(3)
  const fourth = options()[3]
  if (!fourth) {
    throw new Error('no slot')
  }
  await press(fourth, 'Enter')
  expect(chosen).toEqual(['lamp'])
  await m.unmount()
})

test('clicking a slot selects it', async () => {
  const { m, chosen, options } = await show()
  const key = options()[2]
  if (!key) {
    throw new Error('no slot')
  }
  await click(key)
  expect(chosen).toEqual(['key'])
  await m.unmount()
})

test('with a dragType every slot is draggable and carries its id', async () => {
  const m = await mount(
    <SlotGrid
      label="Palette"
      slots={[{ id: 'hall', label: 'Hall', glyph: 'HALL' }]}
      columns={1}
      dragType="application/x-test-piece"
      onSelect={() => undefined}
    />
  )
  const slot = m.host.querySelector<HTMLElement>('[role="option"]')
  expect(slot?.getAttribute('draggable')).toBe('true')
  expect(slot?.querySelector('.px-slot-glyph')?.textContent).toBe('HALL')
  const data = new DataTransfer()
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  slot?.dispatchEvent(event)
  expect(data.getData('application/x-test-piece')).toBe('hall')
  await m.unmount()
})
