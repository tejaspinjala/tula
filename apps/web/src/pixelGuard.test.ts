import { expect, test } from 'bun:test'
import { Glob } from 'bun'

const root = new URL('.', import.meta.url).pathname

/** Comments stripped, so prose about colours does not trip the scan. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '')
}

/** The only place a raw hex colour may live: the tokens. Generated art is binary and never scanned. */
const allowed = new Set(['styles/tokens.css'])

test('no border-radius, backdrop-filter, gradient or raw hex colour in apps/web/src outside tokens.css', async () => {
  const banned: [string, RegExp][] = [
    ['border-radius', /border-radius/],
    ['backdrop-filter', /backdrop-filter/],
    ['gradient', /(?:linear|radial|conic)-gradient/],
    ['raw hex colour', /#[0-9a-fA-F]{3,8}\b/],
  ]
  const hits: string[] = []
  for await (const path of new Glob('**/*.{css,ts,tsx}').scan({ cwd: root })) {
    if (allowed.has(path) || /\.test\.tsx?$/.test(path)) {
      continue
    }
    const text = code(await Bun.file(`${root}${path}`).text())
    for (const [name, re] of banned) {
      if (re.test(text)) {
        hits.push(`${path}: ${name}`)
      }
    }
  }
  expect(hits).toEqual([])
})
