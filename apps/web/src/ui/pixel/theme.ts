/** The element whose attributes carry the theme (`<html>` in the app). */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

/** Everything the theme needs from the browser, injectable for tests. */
export interface ThemeEnv {
  root: ThemeRoot
  storage: {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
  }
  matchMedia: (query: string) => { matches: boolean }
}

/** A Guild Master theme choice; `auto` follows `prefers-color-scheme`. */
export type ThemeChoice = 'auto' | 'day' | 'night'

const THEME_KEY = 'guildhall.theme'
const READABLE_KEY = 'guildhall.readable'

/** The saved theme choice, `auto` when nothing valid is saved. */
export function storedTheme(env: ThemeEnv): ThemeChoice {
  const saved = env.storage.getItem(THEME_KEY)
  return saved === 'day' || saved === 'night' ? saved : 'auto'
}

function apply(env: ThemeEnv, choice: ThemeChoice): void {
  const night =
    choice === 'auto' ? env.matchMedia('(prefers-color-scheme: dark)').matches : choice === 'night'
  env.root.setAttribute('data-theme', night ? 'night' : 'day')
}

/** Whether the "Readable text" setting is on. */
export function readableText(env: ThemeEnv): boolean {
  return env.storage.getItem(READABLE_KEY) === 'true'
}

/** Sets the theme attribute from the saved choice or the system, and the Readable text attribute. */
export function bootTheme(env: ThemeEnv): void {
  apply(env, storedTheme(env))
  if (readableText(env)) {
    env.root.setAttribute('data-readable', 'true')
  } else {
    env.root.removeAttribute('data-readable')
  }
}

/** Saves and applies a Guild Master theme choice. */
export function setTheme(env: ThemeEnv, choice: ThemeChoice): void {
  if (choice === 'auto') {
    env.storage.removeItem(THEME_KEY)
  } else {
    env.storage.setItem(THEME_KEY, choice)
  }
  apply(env, choice)
}

/** Switches the "Readable text" setting (system-ui body and prose) and remembers it. */
export function setReadableText(env: ThemeEnv, on: boolean): void {
  if (on) {
    env.storage.setItem(READABLE_KEY, 'true')
    env.root.setAttribute('data-readable', 'true')
  } else {
    env.storage.removeItem(READABLE_KEY)
    env.root.removeAttribute('data-readable')
  }
}

/** The real browser environment, or null where there is no `window` (tests, SSR). */
export function browserThemeEnv(): ThemeEnv | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null
  }
  let storage: ThemeEnv['storage']
  try {
    storage = window.localStorage
  } catch {
    return null
  }
  return {
    root: document.documentElement,
    storage,
    matchMedia: (query) => window.matchMedia(query),
  }
}
