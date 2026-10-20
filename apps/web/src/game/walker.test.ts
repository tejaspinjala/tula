import { expect, test } from 'bun:test'
import { HAND_IN_MS, type Plan, RESEARCH_MS, type Stop } from './behavior'
import type { Spot } from './route'
import { replan, standing, stepWalker, type Walker } from './walker'
import { mapData, type PlaceName, placeNamed } from './world'

const stand = (name: PlaceName): Spot => {
  const place = placeNamed(name)
  return { map: place.map, x: place.stand.x, y: place.stand.y }
}
const stop = (spot: Spot, extra: Partial<Stop> = {}): Stop => ({
  spot,
  anim: 'idle',
  dwellMs: 0,
  hidden: false,
  carry: null,
  line: null,
  ...extra,
})
const plan = (key: string, ...stops: Stop[]): Plan => ({ key, stops })
const walkableOf = (map: Parameters<typeof mapData>[0]) => mapData(map).walkable

/** Steps a walker in 50 ms frames until `until` holds (or 4000 frames), noting each map it is on. */
function run(start: Walker, until: (w: Walker) => boolean, startMs = 0) {
  let w = start
  let now = startMs
  const maps: string[] = [w.map]
  for (let i = 0; i < 4000 && !until(w); i++) {
    now += 50
    w = stepWalker(w, 0.05, now, walkableOf)
    if (maps.at(-1) !== w.map) {
      maps.push(w.map)
    }
  }
  return { w, maps, now }
}

const atSpot = (w: Walker, spot: Spot) =>
  w.map === spot.map && Math.floor(w.pos.x) === spot.x && Math.floor(w.pos.y) === spot.y

test('a Member sent to the Archive leaves the hall by its door, crosses the plaza and appears in the Archive map', () => {
  const shelves = stand('archive-shelves')
  const start = replan(
    standing(stand('steward-desk'), 'idle'),
    plan('read', stop(shelves, { anim: 'read' })),
    0,
    walkableOf,
    false
  )
  const { w, maps } = run(start, (x) => x.arrived)
  expect(maps).toEqual(['hall', 'plaza', 'archive'])
  expect(w.arrived).toBe(true)
  expect(atSpot(w, shelves)).toBe(true)
  expect(w.anim).toBe('read')
})

test('researching goes out along the trail, vanishes at the Wilds for a while, and returns carrying a scroll', () => {
  const desk = stand('steward-desk')
  const wilds = stand('wilds')
  const p = plan(
    'research',
    stop(wilds, { hidden: true, dwellMs: RESEARCH_MS }),
    stop(desk, { anim: 'write', carry: 'scroll' })
  )
  const out = run(replan(standing(desk, 'idle'), p, 0, walkableOf, false), (w) => w.hidden)
  expect(out.maps).toContain('trail')
  expect(atSpot(out.w, wilds)).toBe(true)
  const gone = run(out.w, (w) => !w.hidden, out.now)
  expect(gone.now - out.now).toBeGreaterThanOrEqual(RESEARCH_MS - 100)
  const back = run(gone.w, (w) => w.arrived && atSpot(w, desk), gone.now)
  expect(back.w.carry).toBe('scroll')
  expect(back.w.hidden).toBe(false)
})

test('reduced motion or a first draw puts the Member at the last stop without walking', () => {
  const shelves = stand('archive-shelves')
  const w = replan(
    standing(stand('steward-desk'), 'idle'),
    plan('read', stop(shelves, { anim: 'read' })),
    0,
    walkableOf,
    true
  )
  expect(w.arrived).toBe(true)
  expect(atSpot(w, shelves)).toBe(true)
  expect(w.path).toEqual([])
})

test('a stop that cannot be reached is a teleport, not a stuck Member', () => {
  const nowhere: Spot = { map: 'hall', x: 0, y: 0 }
  const w = replan(
    standing(stand('steward-desk'), 'idle'),
    plan('lost', stop(nowhere)),
    0,
    walkableOf,
    false
  )
  const done = run(w, (x) => x.arrived).w
  expect(done.arrived).toBe(true)
  expect(atSpot(done, nowhere)).toBe(true)
})

test('a hand-in marks the Quest handed in once its dwell is over, then goes to the next stop', () => {
  const board = stand('quest-board')
  const desk = stand('steward-desk')
  const p = plan('done', stop(board, { anim: 'handin', dwellMs: HAND_IN_MS }), stop(desk))
  const start = replan(standing(desk, 'idle'), p, 0, walkableOf, false)
  const atBoard = run(start, (w) => w.arrived && w.anim === 'handin')
  expect(atBoard.w.handedIn).toBe(false)
  const after = run(atBoard.w, (w) => w.handedIn, atBoard.now)
  expect(after.w.handedIn).toBe(true)
  const home = run(after.w, (w) => w.arrived && atSpot(w, desk), after.now)
  expect(atSpot(home.w, desk)).toBe(true)
})

test('the same plan stepped by the same frames always gives the same walker', () => {
  const p = plan('read', stop(stand('archive-shelves'), { anim: 'read' }))
  const go = () =>
    run(replan(standing(stand('seal-desk'), 'idle'), p, 0, walkableOf, false), (w) => w.arrived).w
  expect(go()).toEqual(go())
})

test('a Member standing in an arrival keeps their line count so a line is said once', () => {
  const p = plan(
    'chat',
    stop(stand('quest-board'), { anim: 'chat', line: 'Fine weather for a Quest.' })
  )
  const w = run(
    replan(standing(stand('quest-board'), 'idle'), p, 0, walkableOf, false),
    (x) => x.arrived
  ).w
  expect(w.line).toBe('Fine weather for a Quest.')
  expect(w.arrivals).toBe(1)
  expect(stepWalker(w, 0.05, 99999, walkableOf).arrivals).toBe(1)
})
