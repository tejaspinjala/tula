import { expect, test } from 'bun:test'
import { courierRoute } from './courier'
import { hallLayout } from './layout'

const layout = hallLayout()
const centre = (r: { x: number; y: number; w: number; h: number }) => ({
  x: (r.x + r.w / 2) * layout.tileSize,
  y: (r.y + r.h / 2) * layout.tileSize,
})

test('a courier leaves the source room by its door and ends in the middle of the target room', () => {
  const route = courierRoute(layout, 0, 1) ?? []
  expect(route).toHaveLength(4)
  expect(route[0]).toEqual(centre(layout.rooms[0] ?? { x: 0, y: 0, w: 0, h: 0 }))
  expect(route[1]).toEqual(centre(layout.doorways[0] ?? { x: 0, y: 0, w: 0, h: 0 }))
  expect(route[2]).toEqual(centre(layout.doorways[1] ?? { x: 0, y: 0, w: 0, h: 0 }))
  expect(route[3]).toEqual(centre(layout.rooms[1] ?? { x: 0, y: 0, w: 0, h: 0 }))
})

test('a Hall with no room on the map sends no courier', () => {
  expect(courierRoute(layout, 0, 99)).toBeNull()
  expect(courierRoute(layout, -1, 0)).toBeNull()
  expect(courierRoute(layout, 1, 1)).toBeNull()
})
