import { describe, expect, test } from 'bun:test'
import { type CrossHallHall, resolveCrossHall } from './cross-hall'

const forge: CrossHallHall = { id: 'forge', kind: 'work', members: [{ id: 'bo' }] }
const halls: CrossHallHall[] = [
  { id: 'heralds', kind: 'work', members: [{ id: 'ada' }] },
  forge,
  { id: 'health', kind: 'private', members: [{ id: 'cy' }] },
  { id: 'journal', kind: 'private', members: [] },
]

type Class = 'public' | 'internal' | 'private'

const from = (sourceHall: string, sourceDataClass: Class, toHall: string, toMember?: string) =>
  resolveCrossHall({ halls, sourceHall, sourceDataClass, toHall, toMember })

describe('resolveCrossHall', () => {
  test('resolves a work Hall from a work Hall', () => {
    expect(from('heralds', 'internal', 'forge')).toEqual({ ok: true, hall: forge, member: null })
  })
  test('resolves a Member of the target Hall', () => {
    expect(from('heralds', 'public', 'forge', 'bo')).toEqual({
      ok: true,
      hall: forge,
      member: { id: 'bo' },
    })
  })
  test('unknown_hall for a Hall not in the caller guild (another guild looks the same)', () => {
    expect(from('heralds', 'internal', 'elsewhere')).toEqual({ ok: false, error: 'unknown_hall' })
  })
  test('same_hall when the target is the source Hall', () => {
    expect(from('heralds', 'internal', 'heralds')).toEqual({ ok: false, error: 'same_hall' })
  })
  test('not_in_hall when the Member is not in the target Hall', () => {
    expect(from('heralds', 'internal', 'forge', 'ada')).toEqual({ ok: false, error: 'not_in_hall' })
  })
  test('private_boundary when a private Hall targets a work Hall', () => {
    expect(from('health', 'internal', 'forge')).toEqual({ ok: false, error: 'private_boundary' })
  })
  test('private_boundary when a private-class Quest targets a work Hall', () => {
    expect(from('heralds', 'private', 'forge')).toEqual({ ok: false, error: 'private_boundary' })
  })
  test('private Hall to private Hall is allowed', () => {
    expect(from('health', 'private', 'journal').ok).toBe(true)
  })
  test('a work Quest may reach a private Hall', () => {
    expect(from('heralds', 'internal', 'health').ok).toBe(true)
  })
  test('unknown source Hall is unknown_hall', () => {
    expect(from('nope', 'internal', 'forge')).toEqual({ ok: false, error: 'unknown_hall' })
  })
})
