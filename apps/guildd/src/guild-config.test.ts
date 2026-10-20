import { describe, expect, test } from 'bun:test'
import { classifyChange, defaultConfig, guildConfig, hallAcceptsQuests } from './guild-config'

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
