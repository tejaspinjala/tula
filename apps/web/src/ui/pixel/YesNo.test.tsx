import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { YesNo } = await import('./YesNo')
const { mount, press } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function show(safe: 'yes' | 'no') {
  const answers: boolean[] = []
  const m = await mount(
    <YesNo question="Spend 40 from the Treasury?" safe={safe} onAnswer={(a) => answers.push(a)} />
  )
  const options = () => [...m.host.querySelectorAll<HTMLElement>('[role="option"]')]
  const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true')
  return { m, answers, options, selected }
}

test('it asks the question and offers Yes and No', async () => {
  const { m, options } = await show('no')
  expect(m.host.textContent).toContain('Spend 40 from the Treasury?')
  expect(options().map((o) => o.textContent)).toEqual(['Yes', 'No'])
  await m.unmount()
})

test('the cursor starts on the safe choice and holds the focus', async () => {
  const careful = await show('no')
  expect(careful.selected()?.textContent).toBe('No')
  expect(document.activeElement).toBe(careful.selected() ?? null)
  await careful.m.unmount()
  const easy = await show('yes')
  expect(easy.selected()?.textContent).toBe('Yes')
  await easy.m.unmount()
})

test('Enter answers with the choice under the cursor', async () => {
  const { m, answers, selected } = await show('no')
  const row = selected()
  if (!row) {
    throw new Error('no cursor')
  }
  await press(row, 'Enter')
  expect(answers).toEqual([false])
  await m.unmount()
})

test('Y answers yes and N answers no, in either case', async () => {
  const { m, answers, selected } = await show('no')
  const row = selected()
  if (!row) {
    throw new Error('no cursor')
  }
  await press(row, 'y')
  await press(row, 'N')
  expect(answers).toEqual([true, false])
  await m.unmount()
})

test('Esc declines', async () => {
  const { m, answers, selected } = await show('yes')
  const row = selected()
  if (!row) {
    throw new Error('no cursor')
  }
  await press(row, 'Escape')
  expect(answers).toEqual([false])
  await m.unmount()
})

test('a pointer already resting on Yes when the menu opens does not steal the cursor', async () => {
  const { m, answers, options, selected } = await show('no')
  const yes = options()[0]
  const row = selected()
  if (!yes || !row) {
    throw new Error('no rows')
  }
  await act(async () => {
    yes.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  expect(selected()?.textContent).toBe('No')
  await press(row, 'Enter')
  expect(answers).toEqual([false])
  await m.unmount()
})

test('a real pointermove then a hover moves the cursor', async () => {
  const { m, options, selected } = await show('no')
  const yes = options()[0]
  if (!yes) {
    throw new Error('no rows')
  }
  await act(async () => {
    yes.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
    yes.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  expect(selected()?.textContent).toBe('Yes')
  await m.unmount()
})
