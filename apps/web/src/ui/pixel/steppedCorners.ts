/**
 * A `clip-path: polygon(...)` that cuts every corner into `n` stairs of length `step` (any CSS
 * length, e.g. `var(--px)`), so frames get stepped pixel corners and never a curve. Zero steps is
 * a plain rectangle. Hand-written polygons are not allowed; use this.
 */
export function steppedCorners(step: string, n: number): string {
  if (n <= 0) {
    return 'polygon(0 0, 100% 0, 100% 100%, 0 100%)'
  }
  const near = (m: number) => `calc(${step} * ${m})`
  const far = (m: number) => `calc(100% - calc(${step} * ${m}))`
  const stairs = (cornerX: 'near' | 'far', cornerY: 'near' | 'far'): string[] => {
    const x = (m: number) => (cornerX === 'near' ? near(m) : far(m))
    const y = (m: number) => (cornerY === 'near' ? near(m) : far(m))
    // Walk from the edge point (0, n) in from the corner towards (n, 0), as (x y) pairs.
    const points = [`${cornerX === 'near' ? '0' : '100%'} ${y(n)}`]
    for (let k = 1; k <= n; k++) {
      points.push(`${x(k)} ${y(n - k + 1)}`)
      points.push(`${x(k)} ${k === n ? (cornerY === 'near' ? '0' : '100%') : y(n - k)}`)
    }
    return points
  }
  const topLeft = stairs('near', 'near')
  const topRight = stairs('far', 'near').reverse()
  const bottomRight = stairs('far', 'far')
  const bottomLeft = stairs('near', 'far').reverse()
  return `polygon(${[...topLeft, ...topRight, ...bottomRight, ...bottomLeft].join(', ')})`
}
