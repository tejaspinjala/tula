import { expect, test } from 'bun:test'
import { Glob } from 'bun'

const here = new URL('.', import.meta.url).pathname
const stylesDir = new URL('../../styles/', import.meta.url).pathname

/** Every non-test source file of the kit, with its text. */
async function kitSources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  for await (const path of new Glob('*.{ts,tsx,css}').scan({ cwd: here })) {
    if (path.includes('.test.') || path === 'testing.tsx') {
      continue
    }
    out.push({ path, text: await Bun.file(`${here}${path}`).text() })
  }
  return out
}

/** Comments stripped, so prose about px or colours does not trip the scan. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

test('the kit has a stylesheet and tokens to read', async () => {
  expect(await Bun.file(`${here}pixel.css`).exists()).toBe(true)
  expect(await Bun.file(`${stylesDir}tokens.css`).exists()).toBe(true)
})

test('no raw colour, px length or banned soft effect appears in the kit outside tokens.css', async () => {
  const banned: [string, RegExp][] = [
    ['hex colour', /#[0-9a-fA-F]{3,8}\b/],
    ['colour function', /\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/],
    ['px length', /\b\d*\.?\d+px\b/],
    ['border-radius', /border-radius/],
    ['gradient', /gradient\(/],
    ['blur', /blur\(/],
    ['backdrop-filter', /backdrop-filter/],
    ['ease', /\bease(?:-in|-out|-in-out)?\b/],
  ]
  const hits: string[] = []
  for (const { path, text } of await kitSources()) {
    for (const [name, pattern] of banned) {
      if (pattern.test(code(text))) {
        hits.push(`${path}: ${name}`)
      }
    }
  }
  expect(hits).toEqual([])
})

test('the kit only reads variables that tokens.css defines', async () => {
  const tokens = await Bun.file(`${stylesDir}tokens.css`).text()
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  // Set by components through the CSSOM, not by tokens.
  const runtime = new Set(['--fill', '--cols', '--shift'])
  const missing: string[] = []
  for (const { path, text } of await kitSources()) {
    for (const m of code(text).matchAll(/var\((--[a-z0-9-]+)/g)) {
      const name = m[1]
      if (name && !defined.has(name) && !runtime.has(name)) {
        missing.push(`${path}: ${name}`)
      }
    }
  }
  expect(missing).toEqual([])
})
