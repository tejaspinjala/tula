/** A sprite as rows of palette characters; `.` is transparent. */
export type Rows = readonly string[]

/** One sprite placed at (x, y) on a canvas. */
export type Layer = readonly [Rows, number, number]

/** A transparent `w` by `h` canvas with `layers` stamped in order, first at the back. */
export function paint(w: number, h: number, ...layers: Layer[]): Rows {
  return layers.reduce<Rows>((acc, [item, x, y]) => stamp(acc, x, y, item), blank(w, h))
}

/** A rectangle of transparent pixels. */
export function blank(w: number, h: number): Rows {
  return Array.from({ length: h }, () => '.'.repeat(w))
}

/** `row` repeated `n` times. */
export function rep(row: string, n: number): Rows {
  return Array.from({ length: n }, () => row)
}

/** Swaps palette characters (`{ '3': 'q' }`); characters not named stay. */
export function recolour(rows: Rows, map: Readonly<Record<string, string>>): Rows {
  return rows.map((row) => [...row].map((ch) => map[ch] ?? ch).join(''))
}

/** Joins sprites of equal height side by side. */
export function hcat(...parts: Rows[]): Rows {
  const h = parts[0]?.length ?? 0
  return Array.from({ length: h }, (_, y) => parts.map((p) => p[y] ?? '').join(''))
}

/** Stacks sprites of equal width. */
export function vcat(...parts: Rows[]): Rows {
  return parts.flat()
}

/** Draws `item` onto `base` at (x, y); `.` in the item leaves the base showing. */
export function stamp(base: Rows, x: number, y: number, item: Rows): Rows {
  return base.map((row, j) => {
    const line = item[j - y]
    if (line === undefined) {
      return row
    }
    const chars = [...row]
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch !== undefined && ch !== '.' && x + i >= 0 && x + i < chars.length) {
        chars[x + i] = ch
      }
    }
    return chars.join('')
  })
}

/** A filled rectangle with a one-pixel outline, as a sprite. */
export function box(w: number, h: number, fill: string, out: string): Rows {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) =>
      y === 0 || y === h - 1 || x === 0 || x === w - 1 ? out : fill
    ).join('')
  )
}

/** A filled ellipse with a one-pixel outline (`out` may be `.` for none). */
export function ellipse(w: number, h: number, fill: string, out: string): Rows {
  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  const inside = (x: number, y: number, rx: number, ry: number): boolean =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      if (inside(x, y, w / 2 - 0.1, h / 2 - 0.1)) {
        return inside(x, y, w / 2 - 1.1, h / 2 - 1.1) ? fill : out
      }
      return '.'
    }).join('')
  )
}

/** The colours of a lit, three-quarter block: a top face, its lit edge, the front face and its shade. */
export interface Ramp {
  top: string
  light: string
  front: string
  shade: string
}

/**
 * A block seen from the front and above: a lighter top face of `topDepth` rows, then a darker front
 * face, a lit left edge, a shaded right edge and foot, all in a one-pixel dark outline with soft corners.
 */
export function block(w: number, h: number, topDepth: number, ramp: Ramp, out = 'k'): Rows {
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const edge = y === 0 || y === h - 1 || x === 0 || x === w - 1
      if ((y === 0 || y === h - 1) && (x === 0 || x === w - 1)) {
        return '.'
      }
      if (edge) {
        return out
      }
      if (y <= topDepth) {
        return y === 1 || x === 1 ? ramp.light : ramp.top
      }
      if (y === topDepth + 1) {
        return ramp.light
      }
      if (x === 1) {
        return ramp.light
      }
      if (x === w - 2 || y >= h - 3) {
        return ramp.shade
      }
      return ramp.front
    }).join('')
  )
}
