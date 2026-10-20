import { expect, test } from 'bun:test'
import { choiceFor, framesOf, LOOK_CATALOGUE, lookChoice, lookFor } from './look'

test('a Member id always gets the same look', () => {
  expect(lookFor('member-1')).toEqual(lookFor('member-1'))
  expect(choiceFor('member-1')).toEqual(choiceFor('member-1'))
})

test('different ids give varied looks, all within the character sheet layers', () => {
  const looks = Array.from({ length: 40 }, (_, i) => lookFor(`member-${i}`))
  expect(new Set(looks.map((l) => `${l.body}/${l.outfit}/${l.hair}`)).size).toBeGreaterThan(10)
  for (const l of looks) {
    expect(l.body % 54).toBe(0)
    expect(l.body / 54).toBeLessThan(3)
    expect(l.outfit % 54).toBeGreaterThanOrEqual(6)
    expect(l.outfit % 54).toBeLessThanOrEqual(11)
    expect(l.outfit / 54).toBeLessThan(10)
    expect(l.hair % 54).toBeGreaterThanOrEqual(19)
    expect(l.hair % 54).toBeLessThanOrEqual(26)
    expect(l.hair / 54).toBeLessThan(2)
  }
})

test('a choice maps to sheet frames: body row, outfit row and colour, hair row and colour', () => {
  expect(framesOf({ body: 2, outfitStyle: 3, outfitColor: 4, hairStyle: 1, hairColor: 5 })).toEqual(
    { body: 2 * 54, outfit: 3 * 54 + 6 + 4, hair: 1 * 54 + 19 + 5 }
  )
})

test('the look an id seeds is a valid catalogue choice, and the frames follow it', () => {
  for (let i = 0; i < 40; i++) {
    const id = `member-${i}`
    expect(lookChoice.safeParse(choiceFor(id)).success).toBe(true)
    expect(lookFor(id)).toEqual(framesOf(choiceFor(id)))
  }
})

test('an override replaces the seeded look', () => {
  const mine = { body: 1, outfitStyle: 9, outfitColor: 0, hairStyle: 0, hairColor: 2 }
  expect(lookFor('member-1', mine)).toEqual(framesOf(mine))
})

test('the catalogue refuses an unknown part or an index outside it', () => {
  const ok = { body: 0, outfitStyle: 0, outfitColor: 0, hairStyle: 0, hairColor: 0 }
  expect(lookChoice.safeParse({ ...ok, outfitStyle: LOOK_CATALOGUE.outfitStyle }).success).toBe(
    false
  )
  expect(lookChoice.safeParse({ ...ok, body: -1 }).success).toBe(false)
})
