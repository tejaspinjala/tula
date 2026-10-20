import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ThemeEnv } from './theme'

GlobalRegistrator.register({ url: 'http://localhost/' })
const { ThemeControls } = await import('./ThemeControls')
const { mount, click } = await import('./testing')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function fakeEnv() {
  const attrs = new Map<string, string>()
  const saved = new Map<string, string>()
  const env: ThemeEnv = {
    root: {
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
    },
    storage: {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    },
    matchMedia: () => ({ matches: false }),
  }
  return { env, attrs }
}

test('the Guild Master picks Auto, Day or Night and the Hall changes at once', async () => {
  const { env, attrs } = fakeEnv()
  const m = await mount(<ThemeControls env={env} />)
  const radio = (name: string) =>
    [...m.host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (r) => r.parentElement?.textContent === name
    )
  expect(radio('Auto')?.checked).toBe(true)
  const night = radio('Night')
  if (!night) {
    throw new Error('no Night choice')
  }
  await click(night)
  expect(attrs.get('data-theme')).toBe('night')
  expect(radio('Night')?.checked).toBe(true)
  await m.unmount()
})

test('Readable text can be switched on and off', async () => {
  const { env, attrs } = fakeEnv()
  const m = await mount(<ThemeControls env={env} />)
  const box = m.host.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!box) {
    throw new Error('no checkbox')
  }
  expect(box.parentElement?.textContent).toBe('Readable text')
  await click(box)
  expect(attrs.get('data-readable')).toBe('true')
  await click(box)
  expect(attrs.has('data-readable')).toBe(false)
  await m.unmount()
})
