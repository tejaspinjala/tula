import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { CursorMenu } = await import('./CursorMenu')
const { mount, press, click, hover } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const items = [
  { id: 'quests', label: 'Quest Board' },
  { id: 'seals', label: 'Seals' },
  { id: 'hall', label: 'Hall' },
]

async function show(extra: { onSelect?: (id: string) => void; onBack?: () => void } = {}) {
  const m = await mount(
    <CursorMenu
      label="Go to"
      items={items}
      onSelect={extra.onSelect ?? (() => {})}
      onBack={extra.onBack}
    />
  )
  const list = m.host.querySelector('[role="listbox"]')
  if (!list) {
    throw new Error('no listbox')
  }
  const options = () => [...m.host.querySelectorAll<HTMLElement>('[role="option"]')]
  const selected = () => options().findIndex((o) => o.getAttribute('aria-selected') === 'true')
  return { m, list, options, selected }
}

test('the cursor starts on the first row; exactly one row is in the tab order and it is the selected one', async () => {
  const { m, options, selected } = await show()
  expect(options().map((o) => o.textContent)).toEqual(['Quest Board', 'Seals', 'Hall'])
  expect(selected()).toBe(0)
  expect(options().map((o) => o.tabIndex)).toEqual([0, -1, -1])
  await m.unmount()
})

test('Up and Down move the cursor and wrap at both ends', async () => {
  const { m, list, options, selected } = await show()
  await press(list, 'ArrowDown')
  expect(selected()).toBe(1)
  expect(document.activeElement).toBe(options()[1] ?? null)
  await press(list, 'ArrowDown')
  await press(list, 'ArrowDown')
  expect(selected()).toBe(0)
  await press(list, 'ArrowUp')
  expect(selected()).toBe(2)
  await m.unmount()
})

test('Home and End jump to the first and last rows', async () => {
  const { m, list, selected } = await show()
  await press(list, 'End')
  expect(selected()).toBe(2)
  await press(list, 'Home')
  expect(selected()).toBe(0)
  await m.unmount()
})

test('Enter selects the row under the cursor; Esc and Backspace go back', async () => {
  const chosen: string[] = []
  let backs = 0
  const { m, list } = await show({ onSelect: (id) => chosen.push(id), onBack: () => backs++ })
  await press(list, 'ArrowDown')
  await press(list, 'Enter')
  expect(chosen).toEqual(['seals'])
  await press(list, 'Escape')
  await press(list, 'Backspace')
  expect(backs).toBe(2)
  await m.unmount()
})

test('hovering a row moves the cursor to it and clicking selects it', async () => {
  const chosen: string[] = []
  const { m, options, selected } = await show({ onSelect: (id) => chosen.push(id) })
  const third = options()[2]
  if (!third) {
    throw new Error('no third row')
  }
  await hover(third)
  expect(selected()).toBe(2)
  await click(third)
  expect(chosen).toEqual(['hall'])
  await m.unmount()
})
