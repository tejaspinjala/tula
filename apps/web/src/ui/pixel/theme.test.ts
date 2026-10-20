import { expect, test } from 'bun:test'
import {
  bootTheme,
  readableText,
  setReadableText,
  setTheme,
  storedTheme,
  type ThemeEnv,
  type ThemeRoot,
} from './theme'

function env(opts: { dark: boolean; saved?: Record<string, string> }) {
  const attrs = new Map<string, string>()
  const saved = new Map<string, string>(Object.entries(opts.saved ?? {}))
  const root: ThemeRoot = {
    setAttribute: (k, v) => void attrs.set(k, v),
    removeAttribute: (k) => void attrs.delete(k),
  }
  const e: ThemeEnv = {
    root,
    storage: {
      getItem: (k) => saved.get(k) ?? null,
      setItem: (k, v) => void saved.set(k, v),
      removeItem: (k) => void saved.delete(k),
    },
    matchMedia: (q) => ({ matches: q.includes('dark') ? opts.dark : false }),
  }
  return { e, attrs, saved }
}

test('with no saved choice the theme follows the system: dark means night, light means day', () => {
  const night = env({ dark: true })
  bootTheme(night.e)
  expect(night.attrs.get('data-theme')).toBe('night')
  const day = env({ dark: false })
  bootTheme(day.e)
  expect(day.attrs.get('data-theme')).toBe('day')
})

test('the Guild Master override beats the system and is remembered', () => {
  const m = env({ dark: true })
  setTheme(m.e, 'day')
  expect(m.attrs.get('data-theme')).toBe('day')
  expect(storedTheme(m.e)).toBe('day')
  const fresh = env({ dark: true, saved: Object.fromEntries(m.saved) })
  bootTheme(fresh.e)
  expect(fresh.attrs.get('data-theme')).toBe('day')
})

test('choosing auto forgets the override and follows the system again', () => {
  const m = env({ dark: true, saved: { 'guildhall.theme': 'day' } })
  setTheme(m.e, 'auto')
  expect(storedTheme(m.e)).toBe('auto')
  expect(m.attrs.get('data-theme')).toBe('night')
})

test('an unreadable saved value is ignored', () => {
  const m = env({ dark: false, saved: { 'guildhall.theme': 'purple' } })
  bootTheme(m.e)
  expect(m.attrs.get('data-theme')).toBe('day')
})

test('Readable text is off by default, can be switched on, remembered and booted', () => {
  const m = env({ dark: false })
  bootTheme(m.e)
  expect(readableText(m.e)).toBe(false)
  expect(m.attrs.has('data-readable')).toBe(false)
  setReadableText(m.e, true)
  expect(m.attrs.get('data-readable')).toBe('true')
  const fresh = env({ dark: false, saved: Object.fromEntries(m.saved) })
  bootTheme(fresh.e)
  expect(fresh.attrs.get('data-readable')).toBe('true')
  setReadableText(fresh.e, false)
  expect(fresh.attrs.has('data-readable')).toBe(false)
})
