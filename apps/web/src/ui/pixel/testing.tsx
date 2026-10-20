import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

/** A mounted tree for a test. */
export interface Mounted {
  host: HTMLElement
  unmount: () => Promise<void>
  rerender: (ui: ReactNode) => Promise<void>
}

/** Mounts `ui` into the (happy-dom) document; call `unmount` when the test ends. */
export async function mount(ui: ReactNode): Promise<Mounted> {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(ui)
  })
  return {
    host,
    rerender: async (next) => {
      await act(async () => {
        root.render(next)
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

/** Presses `key` on `target` (keydown, bubbling) inside `act`. */
export async function press(target: Element, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

/** Clicks `target` inside `act`. */
export async function click(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** Moves the pointer over `target` (mouseover then mouseenter) inside `act`. */
export async function hover(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  })
}

/** Focuses `target` inside `act`. */
export async function focus(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.focus()
  })
}

/** Advances fake time by `ms` inside `act` (use with `jest`-style timers from bun:test). */
export async function tick(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

/** Makes `prefers-reduced-motion: reduce` match (or not) for components rendered afterwards. */
export function setReducedMotion(reduce: boolean): void {
  Reflect.set(window, 'matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
