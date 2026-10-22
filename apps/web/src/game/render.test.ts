import { describe, expect, test } from 'bun:test'
import furniture from '../../public/game/furniture.json'
import interiors from '../../public/game/interiors.json'
import { memberSeats, stewardStand } from './actors'
import { lightIsOn } from './lighting'
import {
  type Atlases,
  actorDepth,
  actorShadow,
  freeStanding,
  roomSprites,
  viewportFor,
} from './render'
import { DEPTH, greatHall } from './room'

const sizes = (frames: Record<string, { w: number; h: number }>) =>
  Object.fromEntries(Object.entries(frames).map(([k, f]) => [k, { w: f.w, h: f.h }]))
const atlases: Atlases = {
  interiors: sizes(interiors.frames),
  furniture: sizes(furniture.frames),
}
const halls = [
  { id: 'a', name: 'Forge', kind: 'work' as const, locked: false },
  { id: 'b', name: 'Quiet', kind: 'private' as const, locked: true },
]
const room = greatHall(halls)
const sprite = (frame: string) => {
  const found = roomSprites(room, atlases).find((s) => s.frame === frame)
  if (!found) {
    throw new Error(`no sprite ${frame}`)
  }
  return found
}

describe('y-sort of actors and furniture', () => {
  test('an actor north of the Steward desk draws under its top, one south of it over', () => {
    const top = sprite('steward-desk~top')
    const base = sprite('steward-desk')
    // The desk sits on tile row 5; feet on its north edge are behind it, feet on row 6 in front.
    const north = actorDepth(5 * 16)
    const south = actorDepth(7 * 16)
    expect(north).toBeLessThan(top.depth)
    expect(north).toBeLessThan(base.depth)
    expect(south).toBeGreaterThan(top.depth)
    expect(south).toBeGreaterThan(base.depth)
  })

  test('the top draws above its own base and a base keeps the footprint bottom as its key', () => {
    expect(sprite('steward-desk~top').depth).toBeGreaterThan(sprite('steward-desk').depth)
    expect(sprite('steward-desk').depth).toBe(DEPTH.actor + 6 * 16)
  })

  test('a top frame sits above its base by its own height', () => {
    // The desk footprint bottom edge is 96 px; the base frame is 16 px tall and the top 8 px.
    expect(sprite('steward-desk')).toMatchObject({ x: 128, y: 80 })
    expect(sprite('steward-desk~top')).toMatchObject({ x: 128, y: 72 })
  })

  test('floor draws below every actor', () => {
    const under = roomSprites(room, atlases).filter((s) => s.frame.startsWith('floor-'))
    expect(under.length).toBeGreaterThan(0)
    for (const s of under) {
      expect(s.depth).toBeLessThan(actorDepth(0))
    }
  })
})

describe('shadows', () => {
  test('a character shadow is the 16x8 frame under the feet, below actors', () => {
    expect(actorShadow({ x: 40, y: 100 })).toEqual({
      atlas: 'furniture',
      frame: 'shadow',
      x: 32,
      y: 96,
      depth: DEPTH.shadow,
    })
    expect(DEPTH.shadow).toBeLessThan(actorDepth(0))
  })

  test('free-standing furniture casts a shadow per footprint column; wall-hugging pieces do not', () => {
    const lamp = room.furniture.find((f) => f.frame === 'lamp-floor')
    expect(lamp).toBeDefined()
    if (!lamp) {
      return
    }
    expect(freeStanding(room, lamp)).toBe(true)
    const against = { ...lamp, tile: { x: 5, y: 3, w: 1, h: 1 } }
    expect(freeStanding({ ...room, furniture: [against] }, against)).toBe(false)
    const shadows = roomSprites(room, atlases).filter((s) => s.frame === 'shadow')
    // Steward desk 2, Seal desk 2, Quest Board 2, mailbox 1, gate 2, lamp 1, plant 1.
    expect(shadows.length).toBe(11)
    expect(shadows.every((s) => s.depth === DEPTH.shadow)).toBe(true)
  })
})

describe('the reserved HUD strip', () => {
  test('the viewport starts below the HUD and keeps the rest of the screen', () => {
    expect(viewportFor({ w: 390, h: 844 }, 120)).toEqual({ x: 0, y: 120, w: 390, h: 724 })
  })

  test('the strip never overlaps the viewport, even when the HUD is taller than the screen', () => {
    for (const hud of [0, 64, 300, 900]) {
      const v = viewportFor({ w: 1280, h: 800 }, hud)
      expect(v.y).toBeGreaterThanOrEqual(Math.min(hud, 800))
      expect(v.y + v.h).toBe(800)
      expect(v.h).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('lights', () => {
  const light = (kind: 'window' | 'sconce' | 'lamp') => ({ kind, tile: { x: 1, y: 1 }, radius: 3 })
  test('windows glow by day, lamps and sconces from dusk', () => {
    expect(lightIsOn('day', light('window'))).toBe(true)
    expect(lightIsOn('day', light('lamp'))).toBe(false)
    expect(lightIsOn('night', light('window'))).toBe(false)
    expect(lightIsOn('night', light('sconce'))).toBe(true)
    expect(lightIsOn('dusk', light('lamp'))).toBe(true)
  })
})

describe('Great Hall positions', () => {
  test('Members get distinct open floor tiles clear of stands and doorway fronts', () => {
    const seats = memberSeats(room, 6)
    expect(new Set(seats.map((p) => `${p.x},${p.y}`)).size).toBe(6)
    const blocked = new Set([
      ...room.pois.map((p) => `${p.stand.x},${p.stand.y}`),
      ...room.doorways.map((d) => `${d.tile.x},${d.tile.y + (d.tile.y > 5 ? -1 : 1)}`),
    ])
    for (const p of seats) {
      expect(room.walkable(p.x, p.y)).toBe(true)
      expect(blocked.has(`${p.x},${p.y}`)).toBe(false)
    }
  })

  test('the Steward stands in front of their desk', () => {
    expect(stewardStand(room)).toEqual({ x: 8, y: 6 })
  })
})
