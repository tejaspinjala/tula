import { describe, expect, test } from 'bun:test'
import { guildMap, mapLayout, mapSummary, miniView, moveCursor, type TownMap } from './guildmap'
import { greatHall, type Room, type RoomHall, roomFor } from './room'
import type { SceneMember, SceneRoom, SceneState } from './scene'
import type { MapKey } from './world'

const hall = (id: string, name: string, kind: 'work' | 'private', locked: boolean, index: number) =>
  ({ id, name, kind, locked, index }) satisfies RoomHall
const halls = [
  hall('w', 'Works', 'work', false, 0),
  hall('p', 'Health', 'private', false, 1),
  hall('l', 'Vault', 'work', true, 2),
]
const roomsByKey = new Map<string, Room>([['hall', greatHall(halls)]])
for (const h of halls) {
  const ids = h.id === 'w' ? ['a', 'b', 'c'] : h.id === 'p' ? ['d'] : ['e']
  roomsByKey.set(
    `hall:${h.id}`,
    roomFor(
      h,
      ids.map((id) => ({ id, captain: id === 'a' })),
      'workshop'
    )
  )
}
const member = (id: string, hallId: string, extra: Partial<SceneMember> = {}): SceneMember => ({
  id,
  name: id.toUpperCase(),
  hallId,
  rank: 'member',
  status: 'idle',
  questId: null,
  bubble: null,
  claimSeq: null,
  ...extra,
})
const sceneRoom = (h: RoomHall, memberIds: string[], board: number): SceneRoom => ({
  hallId: h.id,
  name: h.name,
  kind: h.kind,
  locked: h.locked,
  paused: false,
  memberIds,
  board,
})
const scene: SceneState = {
  rooms: [
    sceneRoom(halls[0] as RoomHall, ['a', 'b', 'c'], 2),
    sceneRoom(halls[1] as RoomHall, ['d'], 0),
    sceneRoom(halls[2] as RoomHall, ['e'], 0),
  ],
  members: {
    a: member('a', 'w', { status: 'working' }),
    b: member('b', 'w', { status: 'working', awaitingSeal: true }),
    c: member('c', 'w'),
    d: member('d', 'p'),
    e: member('e', 'l'),
  },
  stewardId: 's',
  scrolls: [
    { questId: 'q1', title: 'One' },
    { questId: 'q2', title: 'Two' },
  ],
  apprentices: [],
  campaigns: [],
  gateClosed: true,
  couriers: [],
  coinsCents: 0,
  appliedSeq: 0,
}
const towns: Partial<Record<MapKey, TownMap>> = {
  plaza: { width: 36, height: 20, links: ['hall', 'archive', 'counting-house', 'trail'] },
  archive: { width: 16, height: 12, links: ['plaza'] },
  'counting-house': { width: 14, height: 10, links: ['plaza'] },
  trail: { width: 28, height: 10, links: ['plaza'] },
}
const build = (current: 'hall' | 'hall:w' = 'hall') =>
  guildMap({
    scene,
    roomOf: (k) => roomsByKey.get(k) ?? null,
    townOf: (k) => towns[k] ?? null,
    current,
    master: { x: 3, y: 4 },
    unread: 5,
  })

describe('the Guild Map model', () => {
  test('Member marks are working, waiting_seal, idle or away', () => {
    const states = Object.fromEntries(
      build().marks.flatMap((m) => (m.kind === 'member' ? [[m.id, m.state]] : []))
    )
    expect(states).toEqual({ a: 'working', b: 'waiting_seal', c: 'idle', d: 'idle', e: 'away' })
  })

  test('the Seal desk carries the waiting count, the Mailbox the unread count', () => {
    const pois = build().marks.flatMap((m) => (m.kind === 'poi' ? [m] : []))
    expect(pois.find((p) => p.poi === 'seal-desk')?.count).toBe(2)
    expect(pois.find((p) => p.poi === 'mailbox')?.count).toBe(5)
    expect(pois.find((p) => p.poi === 'gate')?.closed).toBe(true)
  })

  test('rooms carry private and locked flags, member counts and doorway links', () => {
    const byId = Object.fromEntries(build().rooms.map((r) => [r.id, r]))
    expect(byId['hall:p']).toMatchObject({
      private: true,
      locked: false,
      memberCount: 1,
      name: 'Health',
    })
    expect(byId['hall:l']).toMatchObject({ locked: true, private: false })
    expect(byId['hall:w']?.memberCount).toBe(3)
    expect(byId.hall?.links).toContain('hall:w')
    expect(byId['hall:w']?.links).toContain('hall')
    expect(byId['hall:w']?.bounds).toMatchObject({ x: 0, y: 0 })
  })

  test('the plaza, Archive, Counting House and trail are rooms with their doorway links', () => {
    const byId = Object.fromEntries(build().rooms.map((r) => [r.id, r]))
    expect(byId.plaza).toMatchObject({
      name: 'Plaza',
      kind: 'town',
      hallId: null,
      locked: false,
      private: false,
      memberCount: 0,
      bounds: { x: 0, y: 0, w: 36, h: 20 },
    })
    expect(byId.plaza?.links).toEqual(['hall', 'archive', 'counting-house', 'trail'])
    expect(byId.archive?.name).toBe('Archive')
    expect(byId['counting-house']?.name).toBe('Counting House')
    expect(byId.trail?.name).toBe('Trail')
    expect(byId.trail?.links).toEqual(['plaza'])
    expect(byId.hall?.links).toContain('plaza')
  })

  test('the Guild Master is a mark in the current room', () => {
    expect(build('hall:w').marks).toContainEqual({
      kind: 'guildMaster',
      room: 'hall:w',
      tile: { x: 3, y: 4 },
    })
  })
})

describe('the mini map view', () => {
  test('draws at a whole-number scale and keeps the Guild Master in view', () => {
    const small = miniView({ w: 12, h: 8 }, { x: 6, y: 4 }, { w: 64, h: 48 })
    expect(small).toMatchObject({ scale: 5, originX: 0, originY: 0 })
    const big = miniView({ w: 80, h: 60 }, { x: 78, y: 58 }, { w: 64, h: 48 })
    expect(Number.isInteger(big.scale)).toBe(true)
    expect(big.originX).toBe(80 - Math.floor(64 / big.scale))
  })

  test('the screen-reader summary names the room, neighbours, Members, Seals and mail', () => {
    const text = mapSummary(build('hall'))
    expect(text).toContain('Great Hall')
    expect(text).toContain('Works')
    expect(text).toContain('Health (private)')
    expect(text).toContain('Vault (locked)')
    expect(text).toContain('2 waiting at the Seal desk')
    expect(text).toContain('5 unread in the mailbox')
    expect(mapSummary(build('hall:w'))).toContain('1 waiting for a Seal')
  })
})

describe('the town on the summary and the mini map', () => {
  test('the Great Hall names the plaza as a door; the plaza names the other town maps', () => {
    expect(mapSummary(build('hall'))).toContain('Plaza')
    const inPlaza = guildMap({
      scene,
      roomOf: (k) => roomsByKey.get(k) ?? null,
      townOf: (k) => towns[k] ?? null,
      current: 'plaza',
      master: { x: 3, y: 4 },
      unread: 0,
    })
    const text = mapSummary(inPlaza)
    expect(text).toContain('Mini map: Plaza.')
    expect(text).toContain('Doors lead to Great Hall, Archive, Counting House, Trail.')
  })
})

describe('the Guild Map schematic layout', () => {
  const layout = mapLayout(build())
  const slot = (id: string) => layout.slots.find((s) => s.id === id)

  test('the town maps stack in the column right of the Hall rooms, the plaza level with the Great Hall', () => {
    expect(['plaza', 'archive', 'counting-house', 'trail'].map((id) => [id, slot(id)])).toEqual([
      ['plaza', { id: 'plaza', col: 3, row: 0 }],
      ['archive', { id: 'archive', col: 3, row: 1 }],
      ['counting-house', { id: 'counting-house', col: 3, row: 2 }],
      ['trail', { id: 'trail', col: 3, row: 3 }],
    ])
  })

  test('arrow keys travel the cursor across the town', () => {
    expect(moveCursor(layout, 'hall', 'right')).toBe('plaza')
    expect(moveCursor(layout, 'plaza', 'down')).toBe('archive')
    expect(moveCursor(layout, 'archive', 'down')).toBe('counting-house')
    expect(moveCursor(layout, 'counting-house', 'down')).toBe('trail')
    expect(moveCursor(layout, 'trail', 'down')).toBe('trail')
    expect(moveCursor(layout, 'archive', 'left')).toBe('hall:l')
  })

  test('the Great Hall sits on top, the Hall rooms in a row below, the Town right of them', () => {
    expect(slot('hall')).toMatchObject({ row: 0, col: 1 })
    expect(layout.slots.filter((s) => s.row === 1 && s.col < 3).map((s) => [s.id, s.col])).toEqual([
      ['hall:w', 0],
      ['hall:p', 1],
      ['hall:l', 2],
    ])
    expect(layout.townCol).toBe(3)
  })

  test('arrow keys move to the nearest room that way and stay put at an edge', () => {
    expect(moveCursor(layout, 'hall', 'down')).toBe('hall:p')
    expect(moveCursor(layout, 'hall:w', 'right')).toBe('hall:p')
    expect(moveCursor(layout, 'hall:p', 'left')).toBe('hall:w')
    expect(moveCursor(layout, 'hall:l', 'up')).toBe('hall')
    expect(moveCursor(layout, 'hall:l', 'right')).toBe('archive')
    expect(moveCursor(layout, 'hall:l', 'down')).toBe('counting-house')
    expect(moveCursor(layout, 'hall', 'left')).toBe('hall')
  })
})
