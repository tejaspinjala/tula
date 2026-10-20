import { expect, test } from 'bun:test'
import { fitZoom, hallLayout, openZoom, seatsIn, withClosedDoors } from './layout'

const layout = hallLayout()

test('the Tiled hall has six room slots, two desks, a gate and a coin counter', () => {
  expect(layout.rooms).toHaveLength(6)
  expect(layout.rooms.map((r) => r.slot)).toEqual([0, 1, 2, 3, 4, 5])
  expect(layout.stewardDesk.w).toBeGreaterThan(0)
  expect(layout.sealDesk.w).toBeGreaterThan(0)
  expect(layout.gate.h).toBeGreaterThan(0)
  expect(layout.coins.w).toBeGreaterThan(0)
})

test('walls and furniture block; room floors and doorways are walkable', () => {
  expect(layout.walkable(0, 0)).toBe(false)
  const room = layout.rooms[0]
  expect(room).toBeDefined()
  if (!room) {
    return
  }
  expect(layout.walkable(room.x + 5, room.y + 5)).toBe(true)
  const door = layout.doorways[0]
  expect(door).toBeDefined()
  if (door) {
    expect(layout.walkable(door.x, door.y)).toBe(true)
  }
  expect(layout.walkable(-1, 3)).toBe(false)
  expect(layout.walkable(999, 3)).toBe(false)
})

test('every room is reachable on foot from the Steward desk (a player can walk to any Hall)', () => {
  const start = { x: layout.stewardDesk.x, y: layout.stewardDesk.y + layout.stewardDesk.h }
  const seen = new Set<string>([`${start.x},${start.y}`])
  const queue = [start]
  for (let at = queue.shift(); at; at = queue.shift()) {
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = at.x + dx
      const y = at.y + dy
      if (layout.walkable(x, y) && !seen.has(`${x},${y}`)) {
        seen.add(`${x},${y}`)
        queue.push({ x, y })
      }
    }
  }
  expect(seen.has(`${start.x},${start.y}`)).toBe(true)
  for (const room of layout.rooms) {
    expect(seen.has(`${room.x + 5},${room.y + 5}`)).toBe(true)
  }
})

test('seatsIn gives distinct walkable tiles inside the room, one per Member', () => {
  const room = layout.rooms[1]
  expect(room).toBeDefined()
  if (!room) {
    return
  }
  const seats = seatsIn(layout, room, 6)
  expect(seats).toHaveLength(6)
  expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(6)
  for (const s of seats) {
    expect(layout.walkable(s.x, s.y)).toBe(true)
    expect(s.x).toBeGreaterThanOrEqual(room.x)
    expect(s.x).toBeLessThan(room.x + room.w)
    expect(s.y).toBeGreaterThanOrEqual(room.y)
    expect(s.y).toBeLessThan(room.y + room.h)
  }
})

test('the door of a locked or empty room blocks entry; an open room keeps its doorway', () => {
  const walk = withClosedDoors(layout, [{ locked: true }, { locked: false }])
  const [shut, open, empty] = [layout.doorways[0], layout.doorways[1], layout.doorways[2]]
  if (!(shut && open && empty)) {
    throw new Error('map has no doorways')
  }
  expect(walk(shut.x, shut.y)).toBe(false)
  expect(walk(open.x, open.y)).toBe(true)
  expect(walk(empty.x, empty.y)).toBe(false)
  expect(walk(0, 0)).toBe(false)
})

test('the fit zoom fills the frame; a phone opens at a readable zoom of one', () => {
  expect(fitZoom(940, 587, 640, 400)).toBe(1.46)
  expect(fitZoom(358, 340, 640, 400)).toBe(0.55)
  expect(fitZoom(10, 10, 640, 400)).toBe(0.25)
  expect(openZoom(358, 340, 640, 400)).toBe(1)
  expect(openZoom(940, 587, 640, 400)).toBe(1.46)
})
