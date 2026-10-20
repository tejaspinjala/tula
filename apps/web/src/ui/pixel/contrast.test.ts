import { expect, test } from 'bun:test'

const tokensPath = new URL('../../styles/tokens.css', import.meta.url)

function parseBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`)
  const out = new Map<string, string>()
  if (start < 0) {
    return out
  }
  const body = css.slice(start, css.indexOf('}', start))
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    const name = m[1]
    const value = m[2]
    if (name && value) {
      out.set(name, value.trim())
    }
  }
  return out
}

function resolver(layers: Map<string, string>[]) {
  const lookup = (name: string): string | undefined => {
    for (const layer of layers) {
      const value = layer.get(name)
      if (value !== undefined) {
        return value
      }
    }
    return undefined
  }
  const color = (name: string): string => {
    const raw = lookup(name)
    const ref = raw?.match(/^var\((--[a-z0-9-]+)\)$/)?.[1]
    if (ref) {
      return color(ref)
    }
    if (!raw || !/^#[0-9a-f]{6}$/i.test(raw)) {
      throw new Error(`${name} is not a colour: ${raw}`)
    }
    return raw
  }
  return color
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

const css = await Bun.file(tokensPath).text()
const day = resolver([parseBlock(css, ':root')])
const night = resolver([parseBlock(css, ':root[data-theme="night"]'), parseBlock(css, ':root')])

// [foreground, background, minimum ratio]: text pairs need 4.5, borders and focus need 3.
const PAIRS: [string, string, number][] = [
  ['--px-text', '--px-paper', 4.5],
  ['--px-text', '--px-paper-200', 4.5],
  ['--px-text-muted', '--px-paper', 4.5],
  ['--px-text-muted', '--px-paper-200', 4.5],
  ['--px-dialog-text', '--px-dialog', 4.5],
  ['--px-on-gold', '--px-gold-500', 4.5],
  ['--px-on-wood', '--px-wood-700', 4.5],
  ['--px-on-danger', '--px-danger-700', 4.5],
  ['--px-on-hover', '--px-wood-100', 4.5],
  ['--px-on-hover', '--px-danger-400', 4.5],
  ['--px-sky-700', '--px-paper', 4.5],
  ['--px-sky-700', '--px-paper-200', 4.5],
  ['--px-grass-700', '--px-paper', 4.5],
  ['--px-danger-700', '--px-paper', 4.5],
  ['--px-ink', '--px-paper-200', 3],
  ['--px-line', '--px-paper-200', 3],
  ['--px-line', '--px-paper', 3],
  ['--px-dialog-frame', '--px-dialog', 3],
  // Pairs the screens actually use (title wordmark and tagline, badges, work notes, warnings).
  ['--px-gold-500', '--px-wood-900', 4.5],
  ['--px-wood-100', '--px-wood-900', 4.5],
  ['--px-danger-700', '--px-paper-200', 4.5],
  ['--px-grass-700', '--px-paper-200', 4.5],
  ['--px-on-grass', '--px-grass-700', 4.5],
  ['--px-on-warn', '--px-warn-500', 4.5],
  ['--px-on-wood', '--px-wood-900', 4.5],
  ['--px-dialog-text', '--px-dialog-shadow', 3],
]

for (const [theme, color] of [
  ['day', day],
  ['night', night],
] as const) {
  test(`every measured pair meets WCAG in the ${theme} theme`, () => {
    const failing = PAIRS.flatMap(([fg, bg, min]) => {
      const got = ratio(color(fg), color(bg))
      return got >= min ? [] : [`${fg} on ${bg}: ${got.toFixed(2)} < ${min}`]
    })
    expect(failing).toEqual([])
  })
}

test('by day the gold ring keeps 3:1 against the ink edge outside it; by night the ring itself stands out from the paper', () => {
  expect(ratio(day('--px-gold-500'), day('--px-ink'))).toBeGreaterThanOrEqual(3)
  expect(ratio(night('--px-gold-500'), night('--px-paper'))).toBeGreaterThanOrEqual(3)
  expect(ratio(night('--px-ink'), night('--px-paper'))).toBeGreaterThanOrEqual(3)
})
