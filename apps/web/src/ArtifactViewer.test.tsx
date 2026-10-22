import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const realFetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
const { createRoot } = await import('react-dom/client')
const { ArtifactViewer } = await import('./ArtifactViewer')

let body = ''

beforeAll(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
  globalThis.fetch = Object.assign(
    async () => new Response(body, { headers: { 'x-artifact-class': 'handoff' } }),
    { preconnect: realFetch.preconnect }
  )
})
afterAll(async () => {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

async function open(text: string) {
  body = text
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<ArtifactViewer session={session} />)
  })
  const input = host.querySelector('input[aria-label="Artifact hash"]')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('no hash input')
  }
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(input, 'abc')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    host
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return host
}

test('long prose opens in a framed reader that scrolls and wraps', async () => {
  const host = await open('word '.repeat(2000))
  const reader = host.querySelector('[aria-label="Artifact text"]')
  expect(reader?.classList.contains('artifact-reader')).toBe(true)
  expect(host.querySelector('pre.artifact-code')).toBeNull()
})

test('code-like artifacts open in a monospace block', async () => {
  const host = await open('{\n  "name": "Wren",\n  "renown": 3\n}')
  expect(host.querySelector('[aria-label="Artifact text"] pre.artifact-code')).not.toBeNull()
})

test('the reader styles scroll and wrap with tokens only', async () => {
  const css = await Bun.file(new URL('./work.css', import.meta.url)).text()
  const rule = css.match(/\.artifact-reader\s*\{[^}]*\}/)?.[0] ?? ''
  expect(rule).toContain('overflow-y: auto')
  expect(rule).toContain('overflow-wrap: anywhere')
  expect(rule).toContain('max-height')
  const code = css.match(/\.artifact-code\s*\{[^}]*\}/)?.[0] ?? ''
  expect(code).toContain('var(--font-mono)')
  expect(code).toContain('white-space: pre-wrap')
})
