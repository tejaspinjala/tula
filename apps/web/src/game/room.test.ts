import { describe, expect, test } from 'bun:test'
import {
  defaultStyle,
  greatHall,
  type Point,
  ROOM_STYLES,
  type Room,
  type RoomHall,
  type RoomMember,
  roomFor,
} from './room'

const hall = (id: string, over: Partial<RoomHall> = {}): RoomHall => ({
  id,
  name: id,
  kind: 'work',
  locked: false,
  ...over,
})
const members = (n: number, captain = true): RoomMember[] =>
  Array.from({ length: n }, (_v, i) => ({ id: `m${i}`, captain: captain && i === 0 }))
const NOWHERE: Point = { x: -1, y: -1 }

/** Breadth-first reach over walkable tiles, written independently of the model. */
function reaches(room: Room, from: Point, to: Point): boolean {
  const seen = new Set<string>([`${from.x},${from.y}`])
  const queue: Point[] = [from]
  while (queue.length > 0) {
    const at = queue.shift()
    if (!at) {
      break
    }
    if (at.x === to.x && at.y === to.y) {
      return true
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const next = { x: at.x + dx, y: at.y + dy }
      const key = `${next.x},${next.y}`
      if (!seen.has(key) && room.walkable(next.x, next.y)) {
        seen.add(key)
        queue.push(next)
      }
    }
  }
  return false
}

describe('roomFor', () => {
  test('gives every Member a station and seats the Captain at the head desk', () => {
    const room = roomFor(hall('heralds'), members(4), 'writing-room')
    expect(room.stations).toHaveLength(4)
    expect(room.stations.map((s) => s.memberId)).toEqual(['m0', 'm1', 'm2', 'm3'])
    const [head, ...rest] = room.stations
    expect(head?.captain).toBe(true)
    expect(rest.every((s) => !s.captain)).toBe(true)
    // The head desk is the one nearest the back wall.
    expect(Math.min(...rest.map((s) => s.tile.y))).toBeGreaterThan(head?.tile.y ?? 99)
  })

  test('seats the Captain first even when listed last', () => {
    const room = roomFor(
      hall('h'),
      [{ id: 'a' }, { id: 'b' }, { id: 'cap', captain: true }],
      'library'
    )
    expect(room.stations[0]?.memberId).toBe('cap')
  })

  test('stations stand free of furniture and reach the doorway', () => {
    for (const style of ROOM_STYLES) {
      for (const n of [1, 4, 5, 8, 9, 12]) {
        const room = roomFor(hall('h'), members(n), style)
        const door = room.doorways[0]
        expect(door).toBeDefined()
        const spot = { x: door?.tile.x ?? -1, y: (door?.tile.y ?? 0) - 1 }
        for (const s of room.stations) {
          expect(room.walkable(s.tile.x, s.tile.y)).toBe(true)
          expect(reaches(room, s.tile, spot)).toBe(true)
        }
      }
    }
  })

  test('grows S to M to L with the station count', () => {
    const size = (n: number) => roomFor(hall('h'), members(n), 'workshop').size
    expect([size(0), size(4), size(5), size(8), size(9), size(12)]).toEqual([
      'S',
      'S',
      'M',
      'M',
      'L',
      'L',
    ])
    const w = (n: number) => roomFor(hall('h'), members(n), 'workshop').width
    expect(w(5)).toBeGreaterThan(w(4))
    expect(w(9)).toBeGreaterThan(w(8))
  })

  test('a Hall past twelve Members still gives each a reachable station', () => {
    const room = roomFor(hall('h'), members(15), 'studio')
    expect(room.stations).toHaveLength(15)
    const door = room.doorways[0]
    const spot = { x: door?.tile.x ?? -1, y: (door?.tile.y ?? 0) - 1 }
    for (const s of room.stations) {
      expect(reaches(room, s.tile, spot)).toBe(true)
    }
    const tiles = new Set(room.stations.map((s) => `${s.tile.x},${s.tile.y}`))
    expect(tiles.size).toBe(15)
  })

  test('has a three-tile back wall, depth keys and a doorway back to the Great Hall', () => {
    const room = roomFor(hall('heralds', { index: 2 }), members(2), 'quiet-room')
    expect(room.layers.wallTop.slice(0, room.width).some((f) => f === 'wall-quiet-room-top')).toBe(
      true
    )
    expect(room.layers.wallFace[room.width + 1]).toBe('wall-quiet-room-face-1')
    expect(room.layers.wallFace[2 * room.width + 1]).toBe('wall-quiet-room-face-2')
    const shelf = roomFor(hall('h'), members(1), 'library').furniture.find(
      (f) => f.frame === 'bookshelf'
    )
    expect(shelf?.top).toBe(true)
    expect(shelf?.depth).toBe((shelf?.tile.y ?? 0) + (shelf?.tile.h ?? 0))
    const door = room.doorways[0]
    expect(door?.target).toBe('great-hall')
    // It returns to the tile in front of this Hall's doorway (index 2) in the Great Hall.
    const gh = greatHall([hall('a'), hall('b'), hall('heralds')])
    const there = gh.doorways[2]
    expect(door?.entry).toEqual({ x: there?.tile.x ?? NOWHERE.x, y: (there?.tile.y ?? 0) + 1 })
  })

  test('windows and lamps become lights', () => {
    const room = roomFor(hall('h'), members(1), 'writing-room')
    expect(room.lights.some((l) => l.kind === 'window')).toBe(true)
    expect(room.lights.some((l) => l.kind === 'lamp')).toBe(true)
  })
})

describe('greatHall', () => {
  test('has a doorway per Hall in config order with its Hall id and lock', () => {
    const halls = [hall('heralds'), hall('research', { locked: true }), hall('forge')]
    const gh = greatHall(halls)
    const doors = gh.doorways.filter((d) => d.hallId)
    expect(doors.map((d) => d.hallId)).toEqual(['heralds', 'research', 'forge'])
    const xs = doors.map((d) => d.tile.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(doors[1]?.locked).toBe(true)
    expect(doors[0]?.target).toBe('hall:heralds')
  })

  test('holds the Steward, Seal desk, Quest Board, Mailbox, Gate and Council table', () => {
    const gh = greatHall([hall('a')])
    expect(gh.pois.map((p) => p.kind).sort()).toEqual([
      'council-table',
      'gate',
      'mailbox',
      'quest-board',
      'seal-desk',
      'steward-desk',
    ])
  })

  test('every Hall doorway is reachable from the spawn, to the sixth Hall and past it', () => {
    for (const n of [1, 6, 7, 13]) {
      const gh = greatHall(Array.from({ length: n }, (_v, i) => hall(`h${i}`)))
      const doors = gh.doorways.filter((d) => d.hallId)
      expect(doors).toHaveLength(n)
      for (const d of doors) {
        expect(reaches(gh, gh.spawn, { x: d.tile.x, y: d.tile.y + 1 })).toBe(true)
      }
    }
  })

  test('adds a corridor past six Halls and no wing: the main room is unchanged', () => {
    const six = greatHall(Array.from({ length: 6 }, (_v, i) => hall(`h${i}`)))
    const nine = greatHall(Array.from({ length: 9 }, (_v, i) => hall(`h${i}`)))
    expect(nine.width).toBeGreaterThan(six.width)
    expect(nine.height).toBe(six.height)
    expect(nine.pois).toEqual(six.pois)
    const seventh = nine.doorways.filter((d) => d.hallId)[6]
    expect(seventh?.tile.x).toBeGreaterThanOrEqual(six.width)
  })
})

describe('defaultStyle', () => {
  test('a Private Hall is the quiet room whatever its name', () => {
    expect(defaultStyle({ name: 'Research', kind: 'private' })).toBe('quiet-room')
  })

  test('name keywords pick the style', () => {
    const style = (name: string) => defaultStyle({ name, kind: 'work' })
    expect(style('Heralds Hall')).toBe('writing-room')
    expect(style('Research')).toBe('library')
    expect(style('The Forge')).toBe('workshop')
    expect(style('Design Studio')).toBe('studio')
    expect(style('Wellness')).toBe('infirmary')
    expect(style('Gardeners')).toBe('garden-room')
  })

  test('anything else is a workshop', () => {
    expect(defaultStyle({ name: 'Zorblax', kind: 'work' })).toBe('workshop')
  })
})

describe('the mailbox of a Hall room', () => {
  test('every style and size has a mailbox the Guild Master can reach from the entry, off every station', () => {
    for (const style of ROOM_STYLES) {
      for (const crew of [1, 4, 8, 12]) {
        const room = roomFor(hall('h'), members(crew), style)
        const box = room.pois.find((p) => p.kind === 'mailbox')
        expect(box).toBeDefined()
        if (!box) {
          continue
        }
        expect(room.walkable(box.tile.x, box.tile.y)).toBe(false)
        expect(room.walkable(box.stand.x, box.stand.y)).toBe(true)
        expect(reaches(room, room.spawn, box.stand)).toBe(true)
        expect(room.furniture.some((f) => f.frame === 'mailbox')).toBe(true)
        for (const s of room.stations) {
          expect([s.tile.x, s.tile.y]).not.toEqual([box.tile.x, box.tile.y])
          expect(reaches(room, room.spawn, s.tile)).toBe(true)
        }
      }
    }
  })
})

describe('the Council table of the Great Hall', () => {
  test('is a POI on open floor the Guild Master can stand beside', () => {
    for (const count of [0, 3, 8]) {
      const room = greatHall(Array.from({ length: count }, (_v, i) => hall(`h${i}`)))
      const table = room.pois.find((p) => p.kind === 'council-table')
      expect(table).toBeDefined()
      if (!table) {
        continue
      }
      expect(room.walkable(table.tile.x, table.tile.y)).toBe(false)
      expect(room.walkable(table.stand.x, table.stand.y)).toBe(true)
      expect(reaches(room, room.spawn, table.stand)).toBe(true)
      expect(
        room.furniture.some((f) => f.tile.x === table.tile.x && f.tile.y === table.tile.y)
      ).toBe(true)
    }
  })
})
