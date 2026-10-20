import { describe, expect, test } from 'bun:test'
import {
  classifyChange,
  defaultConfig,
  type GuildConfig,
  guildConfig,
  hallAcceptsQuests,
  questConcurrency,
} from './guild-config'

describe('seeded guild config', () => {
  const config = defaultConfig()

  test('has the Steward, the Heralds Hall with Captain and Members, and three locked private Halls', () => {
    expect(config.steward.name.length).toBeGreaterThan(0)
    const heralds = config.halls.find((h) => h.id === 'heralds')
    expect(heralds?.captain).not.toBeNull()
    expect(heralds?.members.length).toBeGreaterThan(0)
    const locked = config.halls.filter((h) => h.locked).map((h) => h.id)
    expect(locked.sort()).toEqual(['health', 'personal', 'relationships'])
    expect(config.halls.filter((h) => h.locked).every((h) => h.kind === 'private')).toBe(true)
  })

  test('Seal Policy defaults to always and the config parses', () => {
    expect(config.sealPolicy).toBe('always')
    expect(guildConfig.safeParse(config).success).toBe(true)
  })

  test('locked Halls reject Quests, open Halls and unknown Halls are judged by config', () => {
    expect(hallAcceptsQuests(config, 'health')).toEqual({ ok: false, error: 'hall_locked' })
    expect(hallAcceptsQuests(config, 'heralds')).toEqual({ ok: true })
    expect(hallAcceptsQuests(config, 'nope')).toEqual({ ok: false, error: 'hall_not_found' })
  })

  test('a routing profile must name a configured provider', () => {
    const bad = { ...config, routingProfiles: [{ id: 'p', provider: 'ghost', tier: 'cheap' }] }
    expect(guildConfig.safeParse(bad).success).toBe(false)
  })
})

describe('classifyChange', () => {
  const base = defaultConfig()
  test('identical is neutral', () => {
    expect(classifyChange(base, structuredClone(base))).toBe('neutral')
  })
  test('looser Seal Policy and higher caps are widening; stricter and lower are tightening', () => {
    expect(classifyChange(base, { ...base, sealPolicy: 'routine_alone' })).toBe('widening')
    const looser = { ...base, sealPolicy: 'autonomous' as const }
    expect(classifyChange(looser, base)).toBe('tightening')
    expect(
      classifyChange(base, {
        ...base,
        caps: { ...base.caps, dailyTokens: base.caps.dailyTokens + 1 },
      })
    ).toBe('widening')
    expect(classifyChange(base, { ...base, caps: { ...base.caps, dailySpendCents: 0 } })).toBe(
      'tightening'
    )
  })
  test('the Quest concurrency cap defaults, and raising it is widening', () => {
    expect(questConcurrency(base)).toBe(4)
    const raised = { ...base, caps: { ...base.caps, concurrentQuests: 9 } }
    expect(questConcurrency(raised)).toBe(9)
    expect(classifyChange(base, raised)).toBe('widening')
    expect(classifyChange(raised, base)).toBe('tightening')
  })
  test('private eligibility on, unlocking and a new provider are widening', () => {
    const halls = base.halls.map((h) => (h.id === 'health' ? { ...h, privateEligible: true } : h))
    expect(classifyChange(base, { ...base, halls })).toBe('widening')
    const unlocked = base.halls.map((h) => (h.id === 'health' ? { ...h, locked: false } : h))
    expect(classifyChange(base, { ...base, halls: unlocked })).toBe('widening')
    const withProvider = { ...base, providers: [{ id: 'anthropic', auth: 'api_key' as const }] }
    expect(classifyChange(base, withProvider)).toBe('widening')
    expect(classifyChange(withProvider, base)).toBe('tightening')
  })
  test('a new Hall that is private-eligible is widening; renames are neutral', () => {
    const extra = {
      id: 'alchemists',
      name: 'Alchemists',
      kind: 'work' as const,
      locked: false,
      privateEligible: true,
      captain: null,
      members: [],
    }
    expect(classifyChange(base, { ...base, halls: [...base.halls, extra] })).toBe('widening')
    const renamed = base.halls.map((h) => (h.id === 'heralds' ? { ...h, name: 'Criers' } : h))
    expect(classifyChange(base, { ...base, halls: renamed })).toBe('neutral')
  })
  test('widening wins when a change also tightens', () => {
    const next = {
      ...base,
      sealPolicy: 'routine_alone' as const,
      caps: { ...base.caps, dailyTokens: 1 },
    }
    expect(classifyChange(base, next)).toBe('widening')
  })
})

describe('classifyChange fails closed', () => {
  const base = defaultConfig()
  const withHalls = (halls: GuildConfig['halls']): GuildConfig => ({ ...base, halls })
  const hall = (id: string): GuildConfig['halls'][number] => {
    const found = base.halls.find((h) => h.id === id)
    if (!found) {
      throw new Error(`no seeded Hall ${id}`)
    }
    return found
  }
  const without = (id: string) => base.halls.filter((h) => h.id !== id)
  const heralds = hall('heralds')
  const patchHeralds = (patch: Partial<typeof heralds>): GuildConfig =>
    withHalls(base.halls.map((h) => (h.id === 'heralds' ? { ...h, ...patch } : h)))
  const provided: GuildConfig = {
    ...base,
    providers: [{ id: 'anthropic', auth: 'subscription' }],
    routingProfiles: [{ id: 'main', provider: 'anthropic', tier: 'cheap' }],
    schedules: [{ id: 'daily', cron: '0 9 * * *' }],
  }

  const widening: Array<[string, GuildConfig, GuildConfig]> = [
    ['removing a locked private Hall', base, withHalls(without('health'))],
    [
      're-adding a removed private Hall unlocked',
      withHalls(without('health')),
      withHalls([...without('health'), { ...hall('health'), locked: false }]),
    ],
    [
      'a new unlocked private Hall',
      base,
      withHalls([...base.halls, { ...hall('health'), id: 'secrets', locked: false }]),
    ],
    [
      'a Hall turning from private to work',
      base,
      withHalls(base.halls.map((h) => (h.id === 'health' ? { ...h, kind: 'work' as const } : h))),
    ],
    [
      'a Member ranking up',
      base,
      patchHeralds({
        members: heralds.members.map((m) => ({ ...m, rank: 'adept' as const })),
      }),
    ],
    [
      'a new Member',
      base,
      patchHeralds({ members: [...heralds.members, { id: 'new', name: 'N', rank: 'apprentice' }] }),
    ],
    ['a new Captain', base, patchHeralds({ captain: { id: 'other', name: 'Other' } })],
    ['a new schedule', base, { ...base, schedules: [{ id: 'daily', cron: '* * * * *' }] }],
    ['a new routing profile', { ...provided, routingProfiles: [] }, provided],
    [
      'a routing profile changing tier',
      provided,
      { ...provided, routingProfiles: [{ id: 'main', provider: 'anthropic', tier: 'deep' }] },
    ],
    [
      'a provider changing auth',
      provided,
      { ...provided, providers: [{ id: 'anthropic', auth: 'api_key' }] },
    ],
    [
      'a schedule changing its cron',
      provided,
      { ...provided, schedules: [{ id: 'daily', cron: '* * * * *' }] },
    ],
    ['a replaced Steward', base, { ...base, steward: { id: 'someone-else', name: 'X' } }],
  ]
  test.each(widening)('%s is widening', (_name, prev, next) => {
    expect(classifyChange(prev, next)).toBe('widening')
  })

  const tightening: Array<[string, GuildConfig, GuildConfig]> = [
    ['a Member removed', base, patchHeralds({ members: heralds.members.slice(1) })],
    ['a Captain removed', base, patchHeralds({ captain: null })],
    ['a schedule removed', provided, { ...provided, schedules: [] }],
    ['a routing profile removed', provided, { ...provided, routingProfiles: [] }],
    ['an unlocked Hall removed', base, withHalls(without('heralds'))],
    ['a Hall locked', base, patchHeralds({ locked: true })],
  ]
  test.each(tightening)('%s is tightening', (_name, prev, next) => {
    expect(classifyChange(prev, next)).toBe('tightening')
  })

  test('a field the classifier does not know is widening when added or changed', () => {
    const extra = { ...base, danger: true }
    const flipped = { ...base, danger: false }
    expect(classifyChange(base, extra)).toBe('widening')
    expect(classifyChange(extra, extra)).toBe('neutral')
    expect(classifyChange(extra, flipped)).toBe('widening')
    const hallExtra = withHalls(base.halls.map((h) => (h.id === 'health' ? { ...h, open: 1 } : h)))
    expect(classifyChange(base, hallExtra)).toBe('widening')
    const memberExtra = patchHeralds({
      members: heralds.members.map((m) => ({ ...m, admin: true })),
    })
    expect(classifyChange(base, memberExtra)).toBe('widening')
  })
})
