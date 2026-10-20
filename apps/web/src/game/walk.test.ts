import { expect, test } from 'bun:test'
import { hallLayout } from './layout'
import {
  announceRoom,
  direction,
  findPath,
  followPath,
  HALF,
  moveBy,
  roomAt,
  stick,
  teleportTile,
  type Vec,
} from './walk'

const layout = hallLayout()
const open = () => true
const wallAt5 = (x: number) => x !== 5

test('moving in the open goes the full distance', () => {
  expect(moveBy({ x: 2, y: 2 }, 0.5, -0.25, open)).toEqual({ x: 2.5, y: 1.75 })
})

test('a wall stops the hitbox flush against it', () => {
  const p = moveBy({ x: 4.5, y: 2 }, 3, 0, wallAt5)
  expect(p.x).toBeCloseTo(5 - HALF, 6)
  expect(p.y).toBe(2)
})

test('a wall on one axis lets the other axis slide', () => {
  const p = moveBy({ x: 4.5, y: 2 }, 3, 1, wallAt5)
  expect(p.x).toBeCloseTo(5 - HALF, 6)
  expect(p.y).toBeCloseTo(3, 6)
})

test('the hitbox cannot squeeze a corner into a blocked tile', () => {
  const blocked = (x: number, y: number) => !(x === 5 && y === 5)
  const p = moveBy({ x: 4.6, y: 4.5 }, 0.5, 0.5, blocked)
  const overlaps = (v: Vec) => v.x + HALF > 5 && v.x - HALF < 6 && v.y + HALF > 5 && v.y - HALF < 6
  expect(overlaps(p)).toBe(false)
})

test('the hall edge and walls block walking from the entrance', () => {
  const entrance = { x: 38.5, y: 12.5 }
  expect(moveBy(entrance, 5, 0, layout.walkable).x).toBeLessThan(40)
  expect(moveBy(entrance, 0, -5, layout.walkable).y).toBeGreaterThan(10)
})

test('keys give a unit direction; opposite keys cancel; diagonals are not faster', () => {
  expect(direction({ left: false, right: true, up: false, down: false })).toEqual({ x: 1, y: 0 })
  expect(direction({ left: true, right: true, up: false, down: false })).toEqual({ x: 0, y: 0 })
  const d = direction({ left: false, right: true, up: true, down: false })
  expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 6)
  expect(d.y).toBeLessThan(0)
})

test('the stick has a dead zone and caps at full speed', () => {
  expect(stick(2, 1, 40)).toEqual({ x: 0, y: 0 })
  const far = stick(400, 0, 40)
  expect(far.x).toBeCloseTo(1, 6)
  const half = stick(0, 30, 40)
  expect(half.y).toBeGreaterThan(0)
  expect(half.y).toBeLessThanOrEqual(1)
})

test('a path goes around walls and ends on the target; blocked targets have none', () => {
  const walkable = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < 5 && y < 5 && !(x === 2 && y < 4)
  const path = findPath(walkable, { x: 0, y: 0 }, { x: 4, y: 0 })
  expect(path).not.toBeNull()
  expect(path?.at(-1)).toEqual({ x: 4, y: 0 })
  expect(path?.every((t) => walkable(t.x, t.y))).toBe(true)
  expect(findPath(walkable, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull()
})

test('a path leads from the entrance into a room through its doorway', () => {
  const room = layout.rooms[0]
  const door = layout.doorways[0]
  expect(room).toBeDefined()
  expect(door).toBeDefined()
  if (!room || !door) {
    return
  }
  const path = findPath(layout.walkable, { x: 38, y: 12 }, { x: room.x + 5, y: room.y + 4 })
  expect(path).not.toBeNull()
  expect(path?.some((t) => t.x >= door.x && t.x < door.x + door.w && t.y === door.y)).toBe(true)
})

test('following a path moves toward the next tile centre and consumes reached tiles', () => {
  const path = [
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ]
  const a = followPath({ x: 0.5, y: 0.5 }, path, 0.25)
  expect(a.pos.x).toBeCloseTo(0.75, 6)
  expect(a.path).toHaveLength(2)
  const b = followPath({ x: 0.5, y: 0.5 }, path, 1.2)
  expect(b.pos.x).toBeCloseTo(1.7, 6)
  expect(b.path).toEqual([{ x: 2, y: 0 }])
  const c = followPath({ x: 0.5, y: 0.5 }, path, 9)
  expect(c.pos).toEqual({ x: 2.5, y: 0.5 })
  expect(c.path).toEqual([])
})

test('teleporting puts the Guild Master on a walkable tile inside that room', () => {
  layout.rooms.forEach((_room, slot) => {
    const tile = teleportTile(layout.rooms, slot, layout.walkable)
    expect(tile).not.toBeNull()
    if (tile) {
      expect(layout.walkable(tile.x, tile.y)).toBe(true)
      expect(roomAt(layout.rooms, { x: tile.x + 0.5, y: tile.y + 0.5 })).toBe(slot)
    }
  })
  expect(teleportTile(layout.rooms, 99, layout.walkable)).toBeNull()
})

test('the announcement names the Hall, the empty room, or the hallway', () => {
  expect(announceRoom('Research', true)).toBe('You are in the Research Hall.')
  expect(announceRoom(undefined, true)).toBe('You are in an empty room.')
  expect(announceRoom(null, false)).toBe('You are in the hallway.')
})

test('roomAt names the room the position is in, and null in the corridor', () => {
  expect(roomAt(layout.rooms, { x: 5.5, y: 4.5 })).toBe(0)
  expect(roomAt(layout.rooms, { x: 20.5, y: 20.5 })).toBe(4)
  expect(roomAt(layout.rooms, { x: 38.5, y: 12.5 })).toBeNull()
})
