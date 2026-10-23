import { expect, test } from 'bun:test'
import { direction, findPath, followPath, HALF, hallTitle, moveBy, stick, type Vec } from './walk'

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

test('a Hall is titled with Hall once; a name already ending in Hall keeps it', () => {
  expect(hallTitle('Research')).toBe('Research Hall')
  expect(hallTitle('Heralds Hall')).toBe('Heralds Hall')
  expect(hallTitle('Great hall')).toBe('Great hall')
})
