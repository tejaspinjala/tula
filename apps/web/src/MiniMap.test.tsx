import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { GuildMap } from './game/guildmap'

GlobalRegistrator.register({ url: 'http://localhost/', width: 1280, height: 800 })
const { MiniMap } = await import('./MiniMap')
const { click, mount, press } = await import('./ui/pixel/testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const map: GuildMap = {
  current: 'hall',
  rooms: [
    {
      id: 'hall',
      hallId: null,
      name: 'Great Hall',
      kind: 'great',
      locked: false,
      private: false,
      memberCount: 0,
      bounds: { x: 0, y: 0, w: 20, h: 14 },
      links: ['hall:w'],
    },
    {
      id: 'hall:w',
      hallId: 'w',
      name: 'Works',
      kind: 'work',
      locked: false,
      private: false,
      memberCount: 1,
      bounds: { x: 0, y: 0, w: 12, h: 9 },
      links: ['hall'],
    },
  ],
  marks: [
    { kind: 'guildMaster', room: 'hall', tile: { x: 5, y: 5 } },
    { kind: 'poi', poi: 'seal-desk', room: 'hall', tile: { x: 3, y: 2 }, count: 2, closed: false },
  ],
}

async function resize(width: number): Promise<void> {
  await act(async () => {
    window.innerWidth = width
    window.dispatchEvent(new Event('resize'))
  })
}

test('the mini map is a labelled image of the room, with the summary as its name', async () => {
  await resize(1280)
  const m = await mount(<MiniMap map={map} />)
  const img = m.host.querySelector('[role="img"]')
  expect(img?.getAttribute('aria-label')).toContain('Great Hall')
  expect(img?.getAttribute('aria-label')).toContain('2 waiting at the Seal desk')
  expect(m.host.querySelector('canvas')).not.toBeNull()
  await m.unmount()
})

test('M hides and shows the mini map', async () => {
  await resize(1280)
  const m = await mount(<MiniMap map={map} />)
  await press(document.body, 'm')
  expect(m.host.querySelector('canvas')).toBeNull()
  await press(document.body, 'M')
  expect(m.host.querySelector('canvas')).not.toBeNull()
  await m.unmount()
})

test('M typed into a field does not toggle it', async () => {
  await resize(1280)
  const m = await mount(
    <>
      <input aria-label="note" />
      <MiniMap map={map} />
    </>
  )
  const input = m.host.querySelector('input')
  if (!input) {
    throw new Error('no input')
  }
  await press(input, 'm')
  expect(m.host.querySelector('canvas')).not.toBeNull()
  await m.unmount()
})

test('under 600 px it collapses to a framed map button that opens the Guild Map', async () => {
  await resize(390)
  let opened = 0
  const m = await mount(<MiniMap map={map} onOpen={() => opened++} />)
  expect(m.host.querySelector('canvas')).toBeNull()
  const button = m.host.querySelector('button')
  expect(button?.getAttribute('aria-label')).toBe('Open the Guild Map')
  expect(button?.closest('.px-frame')).not.toBeNull()
  if (button) {
    await click(button)
  }
  expect(opened).toBe(1)
  await m.unmount()
})

test('without a Guild Map page the collapsed button does nothing', async () => {
  await resize(390)
  const m = await mount(<MiniMap map={map} />)
  const button = m.host.querySelector('button')
  if (button) {
    await click(button)
  }
  expect(m.host.querySelector('button')).not.toBeNull()
  await m.unmount()
})
