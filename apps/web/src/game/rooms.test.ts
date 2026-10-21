import { expect, test } from 'bun:test'
import { roomProps, roomTags } from './layout'

const hall = (name: string, locked = false, paused = false, kind: 'work' | 'private' = 'work') => ({
  name,
  locked,
  paused,
  kind,
})

test('every Hall past the six map slots still gets a labelled room tag', () => {
  const halls = Array.from({ length: 9 }, (_x, i) => hall(`Hall ${i}`))
  const tags = roomTags(halls, 9)
  expect(tags).toHaveLength(9)
  tags.forEach((tag, i) => {
    expect(tag.text).toBe(`Hall ${i}`)
    expect(tag.veil).toBe(0)
  })
})

test('locked and paused Halls say so; unused slots are a calm labelled locked room, not a bare veil', () => {
  const tags = roomTags([hall('Health', true), hall('Works', false, true)], 4)
  expect(tags[0]).toMatchObject({ text: 'Health (locked)', closed: true })
  expect(tags[1]).toMatchObject({ text: 'Works (paused)', closed: false })
  expect(tags[2]).toMatchObject({ text: 'Locked room', closed: true })
  expect(tags[3]).toMatchObject({ text: 'Locked room', closed: true })
  expect(tags[2]?.veil).toBeLessThan(0.75)
  expect(tags[2]?.veil).toBeGreaterThan(0)
})

test('long names are cut to fit the room label', () => {
  const tags = roomTags([hall('A very long Hall name that overflows')], 1)
  expect(tags[0]?.text.length).toBeLessThanOrEqual(22)
})

test('an unlocked private Hall is a calm lived-in room with a privacy mark; a locked one keeps its veil and has none; a work Hall has none', () => {
  const tags = roomTags(
    [
      hall('Health', false, false, 'private'),
      hall('Personal', true, false, 'private'),
      hall('Works'),
    ],
    3
  )
  expect(tags[0]).toMatchObject({ text: 'Health', closed: false, veil: 0, privateMark: true })
  expect(tags[0]?.warmth).toBeGreaterThan(0)
  expect(tags[1]).toMatchObject({ closed: true, privateMark: false, warmth: 0 })
  expect(tags[1]?.veil).toBeGreaterThan(0)
  expect(tags[2]).toMatchObject({ privateMark: false, warmth: 0 })
})

test('each private room gets its own deterministic cozy props, all inside the room', () => {
  const room = { x: 2, y: 3, w: 24, h: 15 }
  const kinds = (id: string) => roomProps(id, room).map((p) => p.kind)
  expect(roomProps('health', room)).toEqual(roomProps('health', room))
  expect(kinds('health')).toEqual(['plant', 'shelf', 'cushion'])
  expect(kinds('personal')).toEqual(['shelf', 'plant', 'lamp'])
  expect(kinds('relationships')).toEqual(['cushion', 'cushion', 'plant'])
  for (const id of ['health', 'personal', 'relationships']) {
    for (const p of roomProps(id, room)) {
      expect(p.x).toBeGreaterThanOrEqual(room.x)
      expect(p.x).toBeLessThan(room.x + room.w)
      expect(p.y).toBeGreaterThanOrEqual(room.y)
      expect(p.y).toBeLessThan(room.y + room.h)
    }
  }
})
