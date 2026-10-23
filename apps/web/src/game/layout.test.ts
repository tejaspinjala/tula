import { expect, test } from 'bun:test'
import {
  bubbleCentreX,
  bubbleCentreY,
  elderSeats,
  fitZoom,
  hallLayout,
  landing,
  openZoom,
  refitHall,
  seatsIn,
  type TileRect,
  withClosedDoors,
} from './layout'

const layout = hallLayout()

test('the Tiled hall has six room slots, two desks, a gate and a coin counter', () => {
  expect(layout.rooms).toHaveLength(6)
  expect(layout.rooms.map((r) => r.slot)).toEqual([0, 1, 2, 3, 4, 5])
  expect(layout.stewardDesk.w).toBeGreaterThan(0)
  expect(layout.sealDesk.w).toBeGreaterThan(0)
  expect(layout.gate.h).toBeGreaterThan(0)
  expect(layout.chest.w).toBeGreaterThan(0)
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

test('rooms never overlap each other or a doorway, for any roster size', () => {
  for (const halls of [7, 9, 10, 20]) {
    const big = hallLayout(halls)
    const overlap = (a: TileRect, b: TileRect) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    big.rooms.forEach((a, i) => {
      for (const b of big.rooms.slice(i + 1)) {
        expect(overlap(a, b)).toBe(false)
      }
      const door = big.doorways[i]
      expect(door && overlap(a, door)).toBe(false)
      expect(a.y + a.h).toBeLessThanOrEqual(big.height)
    })
    // The corridor beside every doorway is open floor.
    for (const door of big.doorways) {
      expect(big.walkable(door.x, door.y - 1) || big.walkable(door.x, door.y + 1)).toBe(true)
    }
  }
})

test('the hall redraws only when the wing count changes, and reframes only for a free camera in the hall', () => {
  expect(refitHall(6, 6, 'hall', null)).toEqual({ redraw: false, reframe: false })
  expect(refitHall(6, 9, 'hall', null)).toEqual({ redraw: true, reframe: true })
  expect(refitHall(9, 6, 'hall', null)).toEqual({ redraw: true, reframe: true })
  expect(refitHall(6, 9, 'plaza', null)).toEqual({ redraw: true, reframe: false })
  expect(refitHall(6, 9, 'hall', 'm1')).toEqual({ redraw: true, reframe: false })
  // Seven to nine Halls is the same single wing.
  expect(refitHall(7, 9, 'hall', null).redraw).toBe(false)
})

test('a Guild Master left off the shrunk map lands at the entrance; one still on a walkable tile stays', () => {
  const small = hallLayout()
  const entrance = { x: 38.5, y: 12.5 }
  expect(landing({ x: 8.5, y: 30.5 }, small.walkable, entrance)).toEqual(entrance)
  const room = small.rooms[1]
  const on = { x: (room?.x ?? 0) + 5.5, y: (room?.y ?? 0) + 5.5 }
  expect(landing(on, small.walkable, entrance)).toEqual(on)
})

test('the Council chamber stands in the corridor: five tiles wide, blocked, clear of the desks and doorways', () => {
  const c = layout.council
  expect(c.w).toBe(5)
  for (let x = c.x; x < c.x + c.w; x++) {
    expect(layout.walkable(x, c.y + 1)).toBe(false)
  }
  const apart = (r: TileRect) =>
    c.x + c.w <= r.x || r.x + r.w <= c.x || c.y + c.h <= r.y || r.y + r.h <= c.y
  for (const r of [
    layout.stewardDesk,
    layout.sealDesk,
    layout.chest,
    layout.gate,
    ...layout.doorways,
  ]) {
    expect(apart(r)).toBe(true)
  }
  expect(hallLayout(12).council).toEqual(c)
})

test('five elders stand one to a tile along the back of the chamber, inside it', () => {
  const seats = elderSeats(layout)
  expect(seats).toHaveLength(5)
  expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(5)
  const c = layout.council
  for (const s of seats) {
    expect(s.x >= c.x && s.x < c.x + c.w && s.y === c.y).toBe(true)
  }
})

test('the coin spot reserves room for its label and keeps two tiles clear of the Council dais', () => {
  const chest = layout.chest
  const dais = layout.council
  // Icon plus a label such as "$1000.00": about five tiles.
  expect(chest.w).toBeGreaterThanOrEqual(5)
  const margin = 2
  const apart =
    chest.x + chest.w + margin <= dais.x ||
    dais.x + dais.w + margin <= chest.x ||
    chest.y + chest.h + margin <= dais.y ||
    dais.y + dais.h + margin <= chest.y
  expect(apart).toBe(true)
})
