import { expect, test } from 'bun:test'
import { bubbleCentreX, roomTags } from './roomtags'

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

test('a speech bubble is clamped inside the camera view', () => {
  const view = { x: 100, width: 200 }
  expect(bubbleCentreX(view, 120, 150)).toBe(100 + 60 + 1)
  expect(bubbleCentreX(view, 120, 290)).toBe(300 - 60 - 1)
  expect(bubbleCentreX(view, 120, 200)).toBe(200)
  expect(bubbleCentreX(view, 400, 200)).toBe(200)
})
