import { expect, test } from 'bun:test'
import {
  capBadge,
  GUILD_CAPS,
  guildCapValue,
  hallCapValue,
  setGuildCap,
  setHallCap,
  widenedCaps,
} from './caps'
import { type BuilderConfig, parseConfig } from './model'

const base: BuilderConfig = parseConfig({
  steward: { id: 's', name: 'S' },
  caps: { dailyTokens: 5, maxSpawnDepth: 2 },
  halls: [
    {
      id: 'h',
      name: 'H',
      kind: 'work',
      locked: false,
      privateEligible: false,
      captain: null,
      members: [],
      maxConcurrentMembers: 3,
    },
    {
      id: 'g',
      name: 'G',
      kind: 'work',
      locked: false,
      privateEligible: false,
      captain: null,
      members: [],
    },
  ],
})

test('the guild caps carry the server bounds and defaults', () => {
  expect(GUILD_CAPS.map((f) => [f.key, f.min, f.max, f.fallback])).toEqual([
    ['maxChildrenPerQuest', 0, 20, 3],
    ['maxSpawnDepth', 0, 5, 2],
    ['maxQuestsPerCampaign', 0, 100, 10],
    ['maxInquiriesPerQuest', 0, 50, 3],
    ['maxBugReportsPerQuest', 0, 50, 3],
    ['maxDossiersPerQuest', 0, 50, 5],
  ])
})

test('editing a guild cap sets it in caps and keeps every other cap key', () => {
  const next = setGuildCap(base, 'maxChildrenPerQuest', 7)
  expect(next.caps).toEqual({ dailyTokens: 5, maxSpawnDepth: 2, maxChildrenPerQuest: 7 })
  expect(guildCapValue(next, 'maxChildrenPerQuest')).toBe(7)
  expect(guildCapValue(base, 'maxQuestsPerCampaign')).toBe(10)
})

test('editing a Hall cap sets maxConcurrentMembers; null clears it', () => {
  const set = setHallCap(base, 'g', 4)
  expect(set.halls.map((h) => h.maxConcurrentMembers)).toEqual([3, 4])
  const cleared = setHallCap(set, 'h', null)
  expect(cleared.halls[0] && 'maxConcurrentMembers' in cleared.halls[0]).toBe(false)
  expect(hallCapValue(cleared.halls[0] ?? {})).toBe(1000)
})

test('only a raise is widening; a lower or equal value is not', () => {
  expect(widenedCaps(base, setGuildCap(base, 'maxSpawnDepth', 3))).toEqual(['guild:maxSpawnDepth'])
  expect(widenedCaps(base, setGuildCap(base, 'maxSpawnDepth', 1))).toEqual([])
  expect(widenedCaps(base, setHallCap(base, 'h', 9))).toEqual(['hall:h'])
  expect(widenedCaps(base, setHallCap(base, 'h', 2))).toEqual([])
  // removing a limit raises the Hall to unlimited
  expect(widenedCaps(base, setHallCap(base, 'h', null))).toEqual(['hall:h'])
})

test('the Hall badge reads claimed over cap, or no cap when unset', () => {
  expect(capBadge(2, { maxConcurrentMembers: 5 })).toBe('2 / 5')
  expect(capBadge(2, {})).toBe('2 / no cap')
})
