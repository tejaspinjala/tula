import { afterAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { DialogueBox } = await import('./DialogueBox')
const { mount, press, click, setReducedMotion } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => setReducedMotion(false))

const first = 'Welcome back, Guild Master.'
const second = 'The Quest Board has two new Quests.'
const lines = [first, second]

async function show(extra: { onDone?: () => void; lines?: readonly string[] } = {}) {
  const m = await mount(
    <DialogueBox speaker="Ana" lines={extra.lines ?? lines} onDone={extra.onDone ?? (() => {})} />
  )
  const box = m.host.querySelector<HTMLElement>('.px-dialogue')
  if (!box) {
    throw new Error('no dialogue box')
  }
  const text = (sel: string) => m.host.querySelector(sel)?.textContent ?? ''
  return {
    m,
    box,
    live: () => text('[aria-live="polite"]'),
    shown: () => text('.px-dialogue-shown'),
    rest: () => text('.px-dialogue-rest'),
    more: () => m.host.querySelector('.px-dialogue-more'),
  }
}

test('the whole line is in the DOM from the start while only the start of it is revealed', async () => {
  const d = await show()
  expect(d.live()).toBe(first)
  expect(d.shown() + d.rest()).toBe(first)
  expect(d.shown().length).toBeLessThan(first.length)
  expect(d.m.host.textContent).toContain('Ana')
  await d.m.unmount()
})

test('Enter finishes the line, a second Enter advances, and the last Enter is done', async () => {
  let done = 0
  const d = await show({ onDone: () => done++ })
  await press(d.box, 'Enter')
  expect(d.shown()).toBe(first)
  expect(d.more()).not.toBeNull()
  await press(d.box, 'Enter')
  expect(d.live()).toBe(second)
  expect(d.shown().length).toBeLessThan(second.length)
  await press(d.box, 'Enter')
  expect(d.shown()).toBe(second)
  expect(d.more()).toBeNull()
  expect(done).toBe(0)
  await press(d.box, ' ')
  expect(done).toBe(1)
  await d.m.unmount()
})

test('a click finishes the line like Enter does', async () => {
  const d = await show()
  await click(d.box)
  expect(d.shown()).toBe(first)
  await d.m.unmount()
})

test('Esc skips every line at once', async () => {
  let done = 0
  const d = await show({ onDone: () => done++ })
  await press(d.box, 'Escape')
  expect(done).toBe(1)
  expect(d.live()).toBe(second)
  expect(d.shown()).toBe(second)
  await d.m.unmount()
})

test('the ▼ is hidden from assistive tech', async () => {
  const d = await show()
  await press(d.box, 'Enter')
  expect(d.more()?.getAttribute('aria-hidden')).toBe('true')
  await d.m.unmount()
})

test('under reduced motion the whole line shows at once', async () => {
  setReducedMotion(true)
  const d = await show()
  expect(d.shown()).toBe(first)
  expect(d.rest()).toBe('')
  await d.m.unmount()
})
