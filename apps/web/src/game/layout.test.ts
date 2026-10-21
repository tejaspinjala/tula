import { expect, test } from 'bun:test'
import {
  bubbleCentreX,
  bubbleCentreY,
  fitZoom,
  hallLayout,
  openZoom,
  seatsIn,
  withClosedDoors,
} from './layout'

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

test('a speech bubble drops below its speaker when above would cover the room label', () => {
  const rooms = [{ x: 2, y: 2, w: 10, h: 8 }]
  expect(bubbleCentreY(rooms, 16, 100, 50)).toBe(76)
  expect(bubbleCentreY(rooms, 16, 100, 150)).toBe(124)
  expect(bubbleCentreY(rooms, 16, 400, 50)).toBe(24)
})

test('a speech bubble is clamped inside the camera view', () => {
  const view = { x: 100, width: 200 }
  expect(bubbleCentreX(view, 120, 150)).toBe(100 + 60 + 1)
  expect(bubbleCentreX(view, 120, 290)).toBe(300 - 60 - 1)
  expect(bubbleCentreX(view, 120, 200)).toBe(200)
  expect(bubbleCentreX(view, 400, 200)).toBe(200)
})

/** Tiles reachable on foot from the Steward desk. */
function reachable(l: ReturnType<typeof hallLayout>): Set<string> {
  const start = { x: l.stewardDesk.x, y: l.stewardDesk.y + l.stewardDesk.h }
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
      if (l.walkable(x, y) && !seen.has(`${x},${y}`)) {
        seen.add(`${x},${y}`)
        queue.push({ x, y })
      }
    }
  }
  return seen
}

test('a guild with more Halls than the six slots gets a room for every Hall, all reachable on foot', () => {
  for (const halls of [7, 9, 10, 20]) {
    const big = hallLayout(halls)
    expect(big.rooms.length).toBeGreaterThanOrEqual(halls)
    expect(big.rooms.map((r) => r.slot)).toEqual(big.rooms.map((_r, i) => i))
    expect(big.doorways).toHaveLength(big.rooms.length)
    const seen = reachable(big)
    for (const room of big.rooms) {
      expect(seen.has(`${room.x + 5},${room.y + 5}`)).toBe(true)
      expect(seatsIn(big, room, 4)).toHaveLength(4)
    }
    // The gate, desks and coin counter keep their tiles, and the map grows only downward.
    expect(big.gate).toEqual(layout.gate)
    expect(big.sealDesk).toEqual(layout.sealDesk)
    expect(big.height).toBeGreaterThan(layout.height)
    expect(big.width).toBe(layout.width)
  }
})

test('six or fewer Halls keep the map as drawn', () => {
  expect(hallLayout(3).height).toBe(layout.height)
  expect(hallLayout(6).rooms).toEqual(layout.rooms)
})

test('a map for more Halls ships its own Tiled source with the same size as its layout', () => {
  const big = hallLayout(9)
  expect(big.source).toMatchObject({ width: big.width, height: big.height })
})
