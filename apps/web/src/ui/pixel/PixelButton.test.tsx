import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { PixelButton } = await import('./PixelButton')
const { mount, click } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('it is a real button that is not a submit button by default', async () => {
  let clicks = 0
  const m = await mount(<PixelButton onClick={() => clicks++}>Post a Quest</PixelButton>)
  const button = m.host.querySelector('button')
  expect(button?.getAttribute('type')).toBe('button')
  expect(button?.textContent).toBe('Post a Quest')
  if (button) {
    await click(button)
  }
  expect(clicks).toBe(1)
  await m.unmount()
})

test('a disabled button stays visible, is really disabled and ignores clicks', async () => {
  let clicks = 0
  const m = await mount(
    <PixelButton disabled onClick={() => clicks++}>
      Grant the Seal
    </PixelButton>
  )
  const button = m.host.querySelector('button')
  expect(button?.disabled).toBe(true)
  if (button) {
    await click(button)
  }
  expect(clicks).toBe(0)
  await m.unmount()
})

test('a danger button carries an icon and a word, never colour alone', async () => {
  const m = await mount(<PixelButton danger>Bar the Gates</PixelButton>)
  const button = m.host.querySelector('button')
  expect(button?.getAttribute('data-danger')).toBe('true')
  expect(button?.querySelector('.px-btn-icon')?.getAttribute('aria-hidden')).toBe('true')
  expect(button?.textContent).toContain('Bar the Gates')
  await m.unmount()
})

test('a selected tab or pressed toggle looks pressed: its own style, not colour alone', async () => {
  const css = await Bun.file(new URL('./pixel.css', import.meta.url).pathname).text()
  const rule = css.match(/\.px-btn\[aria-selected="true"\][^{]*\{[^}]*\}/)?.[0] ?? ''
  expect(rule).toContain('transform')
  expect(rule).toContain('box-shadow')
  expect(css).toContain('.px-btn[aria-pressed="true"]')
})
