import { expect, test } from 'bun:test'
import { routeBetween } from './route'
import { doorAt, mapData, type PlaceName, placeNamed } from './world'

const stand = (name: PlaceName) => {
  const place = placeNamed(name)
  return { map: place.map, x: place.stand.x, y: place.stand.y }
}

test('a route inside one map is one leg ending on the target tile', () => {
  const desk = stand('steward-desk')
  const seal = stand('seal-desk')
  const legs = routeBetween(desk, seal)
  expect(legs?.length).toBe(1)
  expect(legs?.[0]?.map).toBe('hall')
  expect(legs?.[0]?.path.at(-1)).toEqual({ x: seal.x, y: seal.y })
})

test('a route from the hall to the Archive leaves through doors, one leg per map', () => {
  const shelves = stand('archive-shelves')
  const legs = routeBetween(stand('steward-desk'), shelves)
  expect(legs?.map((l) => l.map)).toEqual(['hall', 'plaza', 'archive'])
  expect(legs?.at(-1)?.path.at(-1)).toEqual({ x: shelves.x, y: shelves.y })
})

test('every leg but the last ends in a door of its map, and the next leg starts at its far side', () => {
  const legs = routeBetween(stand('steward-desk'), stand('wilds')) ?? []
  expect(legs.length).toBeGreaterThan(2)
  legs.slice(0, -1).forEach((leg, i) => {
    const end = leg.path.at(-1)
    const door = end ? doorAt(mapData(leg.map), end.x, end.y) : null
    expect(door).not.toBeNull()
    const next = legs[i + 1]
    expect(next?.map).toBe(door?.to)
    expect(next?.start).toEqual({ x: door?.toX ?? -1, y: door?.toY ?? -1 })
  })
})

test('the same route twice is the same route, and every tile on it is walkable', () => {
  const a = routeBetween(stand('seal-desk'), stand('treasury-vault'))
  expect(routeBetween(stand('seal-desk'), stand('treasury-vault'))).toEqual(a)
  for (const leg of a ?? []) {
    for (const tile of leg.path) {
      expect(mapData(leg.map).walkable(tile.x, tile.y)).toBe(true)
    }
  }
})

test('an unreachable target has no route', () => {
  expect(routeBetween(stand('seal-desk'), { map: 'hall', x: 0, y: 0 })).toBeNull()
})
