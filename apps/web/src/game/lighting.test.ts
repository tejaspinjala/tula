import { describe, expect, test } from 'bun:test'
import { lampPools, lightFadeMs, lightPatches } from './lighting'
import type { Light } from './room'

const window3: Light = { kind: 'window', tile: { x: 4, y: 1 }, radius: 3 }
const lamp: Light = { kind: 'lamp', tile: { x: 8, y: 7 }, radius: 3 }
const sconce: Light = { kind: 'sconce', tile: { x: 2, y: 2 }, radius: 2 }

describe('window light patches', () => {
  test('by day a patch falls on the floor just below each window', () => {
    expect(lightPatches([window3, lamp], 'day')).toEqual([{ x: 4, y: 2, w: 2, h: 2, alpha: 0.18 }])
  })
  test('at dusk the patch slides along the floor, longer and fainter', () => {
    expect(lightPatches([window3], 'dusk')).toEqual([{ x: 5, y: 2, w: 2, h: 3, alpha: 0.12 }])
  })
  test('at night windows cast no patch', () => {
    expect(lightPatches([window3], 'night')).toEqual([])
  })
  test('reduced motion fades in no time; otherwise the change eases', () => {
    expect(lightFadeMs(true)).toBe(0)
    expect(lightFadeMs(false)).toBeGreaterThan(0)
  })
})

describe('lamp pools', () => {
  test('at night a lamp casts three stepped bands, widest first', () => {
    const pools = lampPools([lamp], 'night')
    expect(pools.map((p) => p.radius)).toEqual([3, 2, 1])
    expect(pools.map((p) => p.alpha)).toEqual([0.08, 0.08, 0.08])
    expect(pools.every((p) => p.x === 8.5 && p.y === 7.5)).toBe(true)
  })
  test('at dusk sconces and lamps cast two bands', () => {
    expect(lampPools([sconce], 'dusk').map((p) => p.radius)).toEqual([2, 1])
  })
  test('by day, and for windows, there are no pools', () => {
    expect(lampPools([lamp, sconce], 'day')).toEqual([])
    expect(lampPools([window3], 'night')).toEqual([])
  })
})
