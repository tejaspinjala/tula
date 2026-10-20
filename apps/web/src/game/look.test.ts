import { expect, test } from 'bun:test'
import { lookFor } from './look'

test('a Member id always gets the same look', () => {
  expect(lookFor('member-1')).toEqual(lookFor('member-1'))
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
