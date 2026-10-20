import { expect, test } from 'bun:test'
import { MAP_IDS, type MapId, mapData, PLACE_NAMES, placeNamed } from './world'

test('every named place resolves to a point on its map', () => {
  const expected: Record<string, string> = {
    'seal-desk': 'hall',
    'steward-desk': 'hall',
    'treasury-counter': 'hall',
    'archive-shelves': 'archive',
    'quest-board': 'plaza',
    'treasury-vault': 'vault',
    trail: 'plaza',
    wilds: 'trail',
  }
  for (let slot = 0; slot < 6; slot++) {
    expected[`hall-room-${slot}`] = 'hall'
  }
  expect([...PLACE_NAMES].sort()).toEqual(Object.keys(expected).sort())
  for (const name of PLACE_NAMES) {
    const place = placeNamed(name)
    expect(place.map).toBe(expected[name])
    expect(place.w).toBeGreaterThan(0)
    expect(place.h).toBeGreaterThan(0)
  }
})

test('the Seal desk is where the hall map puts it', () => {
  expect(placeNamed('seal-desk')).toMatchObject({ map: 'hall', x: 34, y: 10, w: 2, h: 2 })
})

test('every named place has a walkable standing tile on its own map', () => {
  for (const name of PLACE_NAMES) {
    const place = placeNamed(name)
    expect(mapData(place.map).walkable(place.stand.x, place.stand.y)).toBe(true)
  }
})

test('every door leads to a walkable tile of an existing map', () => {
  for (const id of MAP_IDS) {
    const map = mapData(id)
    expect(map.doors.length).toBeGreaterThan(0)
    for (const door of map.doors) {
      expect(MAP_IDS).toContain(door.to)
      expect(mapData(door.to).walkable(door.toX, door.toY)).toBe(true)
    }
  }
})

test('every named place can be reached on foot from the hall entrance, through the doors', () => {
  interface Spot {
    map: MapId
    x: number
    y: number
  }
  const key = (spot: Spot) => `${spot.map}:${spot.x},${spot.y}`
  const start: Spot = { map: 'hall', x: 38, y: 12 }
  const seen = new Set([key(start)])
  const queue: Spot[] = [start]
  for (let at = queue.shift(); at; at = queue.shift()) {
    const here = at
    const next: Spot[] = [
      { map: here.map, x: here.x + 1, y: here.y },
      { map: here.map, x: here.x - 1, y: here.y },
      { map: here.map, x: here.x, y: here.y + 1 },
      { map: here.map, x: here.x, y: here.y - 1 },
    ]
    for (const door of mapData(here.map).doors) {
      if (
        here.x >= door.x &&
        here.x < door.x + door.w &&
        here.y >= door.y &&
        here.y < door.y + door.h
      ) {
        next.push({ map: door.to, x: door.toX, y: door.toY })
      }
    }
    for (const n of next) {
      if (mapData(n.map).walkable(n.x, n.y) && !seen.has(key(n))) {
        seen.add(key(n))
        queue.push(n)
      }
    }
  }
  for (const name of PLACE_NAMES) {
    const place = placeNamed(name)
    expect(seen.has(key({ map: place.map, ...place.stand }))).toBe(true)
  }
})
