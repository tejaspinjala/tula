import { afterEach, describe, expect, test } from 'bun:test'
import { roomFor } from './room'
import { routeBetween } from './route'
import {
  barrierNear,
  doorAt,
  type HallSpec,
  landingFor,
  mapData,
  placeNamed,
  setHalls,
  stepThrough,
} from './world'

const spec = (id: string, over: Partial<HallSpec['hall']> = {}, crew = 2): HallSpec => ({
  hall: { id, name: id, kind: 'work', locked: false, ...over },
  members: Array.from({ length: crew }, (_v, i) => ({ id: `${id}-m${i}`, captain: i === 0 })),
})

afterEach(() => setHalls([]))

describe('a room per Hall behind a Great Hall doorway', () => {
  test('stepping on a Hall doorway arrives in its room at the entry, facing in', () => {
    setHalls([spec('a'), spec('b')])
    const door = mapData('hall').doors.find((d) => d.to === 'hall:b')
    expect(door).toBeDefined()
    if (!door) {
      return
    }
    const step = stepThrough('hall', { x: door.x, y: door.y })
    const room = roomFor(
      { id: 'b', name: 'b', kind: 'work', locked: false, index: 1 },
      [
        { id: 'b-m0', captain: true },
        { id: 'b-m1', captain: false },
      ],
      'workshop'
    )
    expect(step).toMatchObject({ kind: 'go', to: 'hall:b', facing: 'up' })
    expect(step?.kind === 'go' && step.at).toEqual(room.spawn)
    expect(mapData('hall:b').walkable(room.spawn.x, room.spawn.y)).toBe(true)
  })

  test('the way back arrives in the Great Hall just inside that Hall doorway, facing in', () => {
    setHalls([spec('a'), spec('b')])
    const back = mapData('hall:b').doors[0]
    expect(back).toBeDefined()
    if (!back) {
      return
    }
    const step = stepThrough('hall:b', { x: back.x, y: back.y })
    const there = mapData('hall').doors.find((d) => d.to === 'hall:b')
    expect(step).toMatchObject({ kind: 'go', to: 'hall', facing: 'down' })
    expect(step?.kind === 'go' && step.at).toEqual({ x: there?.x ?? -1, y: (there?.y ?? -2) + 1 })
  })

  test('the plaza doorway still steps out of the Great Hall, and into it', () => {
    const out = mapData('hall').doors.find((d) => d.to === 'plaza')
    expect(out && stepThrough('hall', { x: out.x, y: out.y })).toMatchObject({
      kind: 'go',
      to: 'plaza',
    })
    const home = mapData('plaza').doors.find((d) => d.to === 'hall')
    expect(home && stepThrough('plaza', { x: home.x, y: home.y })).toMatchObject({
      kind: 'go',
      to: 'hall',
    })
  })

  test('a tile that is no doorway steps nowhere', () => {
    setHalls([spec('a')])
    expect(stepThrough('hall', { x: 8, y: 8 })).toBeNull()
  })

  test('a locked Hall doorway is barred with a sign that says why, and cannot be walked onto', () => {
    setHalls([spec('a'), spec('b', { name: 'Health', locked: true })])
    const hall = mapData('hall')
    expect(hall.doors.some((d) => d.to === 'hall:b')).toBe(false)
    expect(hall.walkable(4, 2)).toBe(false)
    expect(hall.walkable(1, 2)).toBe(true)
    expect(barrierNear('hall', { x: 4, y: 3 })).toBe(
      'Health is locked. Unlock it from the Hall builder.'
    )
    expect(barrierNear('hall', { x: 1, y: 3 })).toBeNull()
    expect(barrierNear('hall', { x: 8, y: 8 })).toBeNull()
  })

  test('a Private Hall (unlocked) can be entered', () => {
    setHalls([spec('p', { kind: 'private', name: 'Personal' })])
    expect(mapData('hall').doors.some((d) => d.to === 'hall:p')).toBe(true)
  })

  test('a Hall added later gets its room', () => {
    setHalls([spec('a')])
    expect(mapData('hall').doors.filter((d) => d.to.startsWith('hall:'))).toHaveLength(1)
    setHalls([spec('a'), spec('c')])
    expect(mapData('hall:c').width).toBeGreaterThan(0)
    expect(mapData('hall').doors.some((d) => d.to === 'hall:c')).toBe(true)
  })

  test('every Hall room is reachable from the plaza and back, even past six Halls', () => {
    setHalls(Array.from({ length: 8 }, (_v, i) => spec(`h${i}`)))
    const plaza = { map: 'plaza' as const, ...placeNamed('quest-board').stand }
    for (let i = 0; i < 8; i++) {
      const room = mapData(`hall:h${i}`)
      const inside = { map: room.id, x: room.doors[0]?.x ?? 0, y: (room.doors[0]?.y ?? 0) - 1 }
      expect(routeBetween(plaza, inside)).not.toBeNull()
      expect(routeBetween(inside, plaza)).not.toBeNull()
    }
  })

  test('the Great Hall doorways open only for unlocked Halls', () => {
    setHalls([spec('a', { locked: true })])
    expect(doorAt(mapData('hall'), 1, 2)).toBeNull()
  })
})

describe('where a map is entered from', () => {
  test('a room is entered at its spawn, a town map where its doorway lands, the Great Hall at its spawn', () => {
    setHalls([spec('a'), spec('b', { locked: true })])
    const room = mapData('hall:a')
    expect(landingFor('hall:a')).toEqual({ x: 4, y: 9 })
    expect(room.walkable(4, 9)).toBe(true)
    const plazaDoor = mapData('hall').doors.find((d) => d.to === 'plaza')
    expect(landingFor('plaza')).toEqual({ x: plazaDoor?.toX ?? -1, y: plazaDoor?.toY ?? -1 })
    expect(landingFor('hall')).toEqual({ x: 8, y: 10 })
    expect(landingFor('trail')).not.toBeNull()
  })

  test('a locked or unknown room has no landing, so a saved visit there falls back', () => {
    setHalls([spec('b', { locked: true })])
    expect(landingFor('hall:b')).toBeNull()
    expect(landingFor('hall:ghost')).toBeNull()
  })
})
