import { expect, test } from 'bun:test'
import { courierRoute } from './courier'
import { hallLayout } from './layout'

const layout = hallLayout()
const centre = (r: { x: number; y: number; w: number; h: number }) => ({
  x: (r.x + r.w / 2) * layout.tileSize,
  y: (r.y + r.h / 2) * layout.tileSize,
})

test('a courier walks door to door through the hallway, never inside a room', () => {
  for (const [from, to] of [
    [0, 1],
    [0, 4],
    [4, 2],
    [5, 3],
  ] as const) {
    const route = courierRoute(layout, from, to) ?? []
    expect(route.length).toBeGreaterThanOrEqual(2)
    expect(route[0]).toEqual(centre(layout.doorways[from] ?? { x: 0, y: 0, w: 0, h: 0 }))
    expect(route.at(-1)).toEqual(centre(layout.doorways[to] ?? { x: 0, y: 0, w: 0, h: 0 }))
    for (const p of route) {
      const tx = p.x / layout.tileSize
      const ty = p.y / layout.tileSize
      const inside = layout.rooms.some(
        (r) => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h
      )
      expect(inside).toBe(false)
    }
  }
})

test('a Hall with no room on the map sends no courier', () => {
  expect(courierRoute(layout, 0, 99)).toBeNull()
  expect(courierRoute(layout, -1, 0)).toBeNull()
  expect(courierRoute(layout, 1, 1)).toBeNull()
})
