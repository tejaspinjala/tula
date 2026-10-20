import { expect, test } from 'bun:test'
import {
  addHall,
  addMember,
  type BuilderConfig,
  deleteHall,
  moveMember,
  parseConfig,
  setLook,
} from './model'
import { instantiate, TEMPLATES } from './templates'

const raw = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    {
      id: 'heralds',
      name: 'Heralds Hall',
      kind: 'work',
      locked: false,
      privateEligible: false,
      captain: { id: 'heralds-captain', name: 'Herald Captain' },
      members: [
        { id: 'm1', name: 'One', rank: 'apprentice' },
        { id: 'm2', name: 'Two', rank: 'journeyman' },
      ],
    },
    {
      id: 'health',
      name: 'Health',
      kind: 'private',
      locked: true,
      privateEligible: false,
      captain: null,
      members: [],
    },
  ],
  sealPolicy: 'always',
  caps: { dailyTokens: 5, dailySpendCents: 6 },
}

function load(): BuilderConfig {
  return parseConfig(raw)
}

test('parsing keeps every key the builder does not edit', () => {
  expect(load().caps).toEqual({ dailyTokens: 5, dailySpendCents: 6 })
  expect(load().sealPolicy).toBe('always')
})

test('moving a Member puts it last in the target Hall and out of the source Hall', () => {
  const next = moveMember(load(), 'm1', { hallId: 'health' })
  expect(next.halls[0]?.members.map((m) => m.id)).toEqual(['m2'])
  expect(next.halls[1]?.members.map((m) => m.id)).toEqual(['m1'])
})

test('moving a Member before another Member reorders within a Hall', () => {
  const next = moveMember(load(), 'm2', { hallId: 'heralds', before: 'm1' })
  expect(next.halls[0]?.members.map((m) => m.id)).toEqual(['m2', 'm1'])
})

test('moving to an unknown Hall changes nothing', () => {
  const start = load()
  expect(moveMember(start, 'm1', { hallId: 'nope' })).toEqual(start)
})

test('adding a blank Hall appends a work Hall with a unique id', () => {
  const once = addHall(load(), 'Scribes')
  const twice = addHall(once, 'Scribes')
  expect(once.halls.at(-1)).toMatchObject({ id: 'scribes', name: 'Scribes', kind: 'work' })
  expect(twice.halls.at(-1)?.id).toBe('scribes-2')
})

test('adding a Member to a Hall gives it a fresh id and the apprentice rank', () => {
  const next = addMember(load(), 'heralds')
  const added = next.halls[0]?.members.at(-1)
  expect(added?.rank).toBe('apprentice')
  expect(new Set(next.halls.flatMap((h) => h.members.map((m) => m.id))).size).toBe(3)
})

test('deleting a Hall removes it', () => {
  expect(deleteHall(load(), 'health').halls.map((h) => h.id)).toEqual(['heralds'])
})

test('there are at least three prebuilt Halls with the promised shapes', () => {
  const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t.hall]))
  expect(Object.keys(byId)).toEqual(expect.arrayContaining(['heralds', 'research', 'review']))
  expect(byId.research?.members).toHaveLength(2)
  expect(byId.research?.captain).not.toBeNull()
  expect(byId.review?.members.map((m) => m.rank)).toEqual(['adept'])
})

test('dropping a prebuilt Hall arrives fully formed with ids that do not clash', () => {
  const template = TEMPLATES.find((t) => t.id === 'heralds')
  if (!template) {
    throw new Error('no heralds template')
  }
  const next = instantiate(load(), template)
  const added = next.halls.at(-1)
  expect(added?.id).not.toBe('heralds')
  expect(added?.name).toBe(template.hall.name)
  expect(added?.captain).not.toBeNull()
  expect(added?.members).toHaveLength(template.hall.members.length)
  const ids = next.halls.flatMap((h) => [
    h.id,
    ...(h.captain ? [h.captain.id] : []),
    ...h.members.map((m) => m.id),
  ])
  expect(new Set(ids).size).toBe(ids.length)
})

test('a Member look override survives parsing, and setLook sets and clears it', () => {
  const look = { body: 1, outfitStyle: 2, outfitColor: 3, hairStyle: 1, hairColor: 4 }
  const withLook = setLook(load(), 'm1', look)
  const members = (c: BuilderConfig) => c.halls[0]?.members
  expect(members(withLook)?.[0]).toMatchObject({ id: 'm1', look })
  expect(members(withLook)?.[1]).not.toHaveProperty('look')
  // A round trip through the server's JSON keeps the override.
  expect(members(parseConfig(JSON.parse(JSON.stringify(withLook))))?.[0]).toMatchObject({ look })
  expect(members(setLook(withLook, 'm1', null))?.[0]).not.toHaveProperty('look')
})

test('dropping the same prebuilt Hall twice keeps ids unique', () => {
  const template = TEMPLATES[0]
  if (!template) {
    throw new Error('no templates')
  }
  const next = instantiate(instantiate(load(), template), template)
  const ids = next.halls.map((h) => h.id)
  expect(new Set(ids).size).toBe(ids.length)
})
