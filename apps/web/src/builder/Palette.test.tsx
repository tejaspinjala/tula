import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { Palette } = await import('./Palette')
const { mount, click } = await import('../ui/pixel/testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const pieces = [
  { id: 'hall', label: 'Add blank Hall', glyph: 'HALL' },
  { id: 'member', label: 'Add blank Member', glyph: 'MBR' },
]

test('the palette is a slot grid whose click adds the piece and whose caption names the cursor slot', async () => {
  const added: string[] = []
  const m = await mount(
    <Palette
      label="Palette"
      pieces={pieces}
      dragType="application/x-test"
      onAdd={(id) => added.push(id)}
    />
  )
  const slots = [...m.host.querySelectorAll<HTMLElement>('[role="option"]')]
  expect(slots.map((s) => s.getAttribute('draggable'))).toEqual(['true', 'true'])
  expect(m.host.querySelector('.palette-caption')?.textContent).toContain('Add blank Hall')
  const second = slots[1]
  if (!second) {
    throw new Error('no slot')
  }
  await click(second)
  expect(added).toEqual(['member'])
  expect(m.host.querySelector('.palette-caption')?.textContent).toContain('Add blank Member')
  await m.unmount()
})
