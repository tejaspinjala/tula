/** The element whose attributes carry the theme. */
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

/** A Guild Master theme choice. */
export type ThemeChoice = 'auto' | 'day' | 'night'

/** Stub for the red run. */
export function storedTheme(_env: ThemeEnv): ThemeChoice {
  return 'auto'
}

/** Stub for the red run. */
export function readableText(_env: ThemeEnv): boolean {
  return false
}

/** Stub for the red run. */
export function bootTheme(_env: ThemeEnv): void {}

/** Stub for the red run. */
export function setTheme(_env: ThemeEnv, _choice: ThemeChoice): void {}

/** Stub for the red run. */
export function setReadableText(_env: ThemeEnv, _on: boolean): void {}
