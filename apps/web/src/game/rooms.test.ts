import { expect, test } from 'bun:test'
import { roomTags } from './layout'

const hall = (name: string, locked = false, paused = false) => ({ name, locked, paused })

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
