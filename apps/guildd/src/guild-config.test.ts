import { describe, expect, test } from 'bun:test'
import {
  campaignQuestCap,
  classifyChange,
  defaultConfig,
  type GuildConfig,
  guildConfig,
  guildContentPolicy,
  guildTreasury,
  hallAcceptsQuests,
  hallMemberCap,
  isLearningRepoAllowed,
  learningRepoAllowlist,
  missiveCap,
  parseStoredConfig,
  questConcurrency,
  researchCap,
  sealPostWindowMs,
  spawnChildrenCap,
  spawnDepthCap,
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
  test('the spawn caps default to 3 children and depth 2; raising either is widening, lowering applies at once', () => {
    expect(spawnChildrenCap(base)).toBe(3)
    expect(spawnDepthCap(base)).toBe(2)
    for (const key of ['maxChildrenPerQuest', 'maxSpawnDepth'] as const) {
      const raised = { ...base, caps: { ...base.caps, [key]: 5 } }
      const lowered = { ...base, caps: { ...base.caps, [key]: 1 } }
      expect(classifyChange(base, raised)).toBe('widening')
      expect(classifyChange(raised, base)).toBe('tightening')
      expect(classifyChange(base, lowered)).toBe('tightening')
      expect(guildConfig.safeParse(raised).success).toBe(true)
      expect(guildConfig.safeParse({ ...base, caps: { ...base.caps, [key]: 1000 } }).success).toBe(
        false
      )
    }
    expect(spawnChildrenCap({ ...base, caps: { ...base.caps, maxChildrenPerQuest: 5 } })).toBe(5)
  })
  test('the campaign cap defaults to 10; raising it is widening, lowering applies at once', () => {
    expect(campaignQuestCap(base)).toBe(10)
    const raised = { ...base, caps: { ...base.caps, maxQuestsPerCampaign: 20 } }
    expect(campaignQuestCap(raised)).toBe(20)
    expect(classifyChange(base, raised)).toBe('widening')
    expect(classifyChange(raised, base)).toBe('tightening')
    expect(classifyChange(base, { ...base, caps: { ...base.caps, maxQuestsPerCampaign: 2 } })).toBe(
      'tightening'
    )
    expect(
      guildConfig.safeParse({ ...base, caps: { ...base.caps, maxQuestsPerCampaign: 101 } }).success
    ).toBe(false)
  })
  test('the Missive cap defaults to 20 per Quest; raising it is widening, lowering applies at once', () => {
    expect(missiveCap(base)).toBe(20)
    const raised = { ...base, caps: { ...base.caps, maxMissivesPerQuest: 50 } }
    expect(missiveCap(raised)).toBe(50)
    expect(classifyChange(base, raised)).toBe('widening')
    expect(classifyChange(raised, base)).toBe('tightening')
    expect(classifyChange(base, { ...base, caps: { ...base.caps, maxMissivesPerQuest: 2 } })).toBe(
      'tightening'
    )
    expect(
      guildConfig.safeParse({ ...base, caps: { ...base.caps, maxMissivesPerQuest: 201 } }).success
    ).toBe(false)
  })
  test('research is off by default; enabling it or raising its cap is widening, lowering applies at once', () => {
    expect(researchCap(base)).toBe(0)
    const enabled = { ...base, caps: { ...base.caps, maxResearchPerQuest: 5 } }
    expect(researchCap(enabled)).toBe(5)
    expect(classifyChange(base, enabled)).toBe('widening')
    expect(
      classifyChange(enabled, { ...base, caps: { ...base.caps, maxResearchPerQuest: 9 } })
    ).toBe('widening')
    expect(classifyChange(enabled, base)).toBe('tightening')
    expect(
      guildConfig.safeParse({ ...base, caps: { ...base.caps, maxResearchPerQuest: 101 } }).success
    ).toBe(false)
  })
  test('the id `hall` is reserved for Missives: no Member or Captain may take it', () => {
    const [first, ...rest] = base.halls
    if (!first) {
      throw new Error('the default config has a Hall')
    }
    const asMember = { ...first, members: [{ id: 'hall', name: 'X', rank: 'apprentice' as const }] }
    const asCaptain = { ...first, captain: { id: 'hall', name: 'X' } }
    for (const bad of [asMember, asCaptain]) {
      expect(guildConfig.safeParse({ ...base, halls: [bad, ...rest] }).success).toBe(false)
    }
    expect(guildConfig.safeParse(base).success).toBe(true)
  })
  test('a Hall member cap is unlimited when unset; raising it is widening, lowering applies at once', () => {
    const withCap = (n: number | undefined): GuildConfig => ({
      ...base,
      halls: base.halls.map((h) =>
        h.id === 'heralds' ? { ...h, ...(n === undefined ? {} : { maxConcurrentMembers: n }) } : h
      ),
    })
    const heralds = (c: GuildConfig) => {
      const found = c.halls.find((h) => h.id === 'heralds')
      if (!found) {
        throw new Error('no heralds')
      }
      return found
    }
    expect(hallMemberCap(heralds(base))).toBe(1000)
    expect(hallMemberCap(heralds(withCap(2)))).toBe(2)
    expect(classifyChange(withCap(2), withCap(3))).toBe('widening')
    expect(classifyChange(withCap(2), withCap(undefined))).toBe('widening')
    expect(classifyChange(withCap(3), withCap(2))).toBe('tightening')
    expect(classifyChange(withCap(undefined), withCap(2))).toBe('tightening')
    expect(guildConfig.safeParse(withCap(0)).success).toBe(false)
  })
  test('the Seal post window defaults to 72 hours, and raising it is widening', () => {
    expect(sealPostWindowMs(base)).toBe(72 * 3_600_000)
    const raised = { ...base, caps: { ...base.caps, sealPostWindowHours: 100 } }
    expect(classifyChange(base, raised)).toBe('widening')
    expect(classifyChange(raised, base)).toBe('tightening')
  })
  test('adding a cap above the default is widening; removing one below it widens, from it or above tightens', () => {
    const withCap = (n: number | undefined) => ({
      ...base,
      caps: { ...base.caps, ...(n === undefined ? {} : { concurrentQuests: n }) },
    })
    expect(classifyChange(withCap(undefined), withCap(5))).toBe('widening')
    expect(classifyChange(withCap(2), withCap(undefined))).toBe('widening')
    expect(classifyChange(withCap(9), withCap(undefined))).toBe('tightening')
    expect(classifyChange(withCap(5), withCap(undefined))).toBe('tightening')
    expect(classifyChange(withCap(4), withCap(undefined))).toBe('tightening')
  })
  test('flipping a provider privateEligible either way is widening', () => {
    const off = [{ id: 'anthropic', auth: 'api_key' as const, privateEligible: false }]
    const on = [{ id: 'anthropic', auth: 'api_key' as const, privateEligible: true }]
    expect(classifyChange({ ...base, providers: off }, { ...base, providers: on })).toBe('widening')
    expect(classifyChange({ ...base, providers: on }, { ...base, providers: off })).toBe('widening')
  })
  test('private eligibility on, unlocking and a new provider are widening', () => {
    const halls = base.halls.map((h) => (h.id === 'health' ? { ...h, privateEligible: true } : h))
    expect(classifyChange(base, { ...base, halls })).toBe('widening')
    const unlocked = base.halls.map((h) => (h.id === 'health' ? { ...h, locked: false } : h))
    expect(classifyChange(base, { ...base, halls: unlocked })).toBe('widening')
    const withProvider = {
      ...base,
      providers: [{ id: 'anthropic', auth: 'api_key' as const, privateEligible: false }],
    }
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
    providers: [{ id: 'anthropic', auth: 'subscription', privateEligible: false }],
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
      { ...provided, providers: [{ id: 'anthropic', auth: 'api_key', privateEligible: false }] },
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

describe('routing profile model and price', () => {
  const withProfile = (extra: object): unknown => ({
    ...defaultConfig(),
    providers: [{ id: 'cloud', auth: 'api_key', privateEligible: false }],
    routingProfiles: [{ id: 'cloud-mid', provider: 'cloud', tier: 'mid', ...extra }],
  })

  test('a profile may carry the model id and per-million-token prices', () => {
    const parsed = guildConfig.parse(
      withProfile({
        model: 'some-model',
        price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
      })
    )
    expect(parsed.routingProfiles[0]?.model).toBe('some-model')
    expect(parsed.routingProfiles[0]?.price?.outputMicrosPerMTok).toBe(15_000_000)
  })

  test('editing a price or model is widening; the default config has no model id', () => {
    const before = guildConfig.parse(withProfile({ model: 'm' }))
    const after = guildConfig.parse(
      withProfile({ model: 'm', price: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 } })
    )
    expect(classifyChange(before, after)).toBe('widening')
    expect(JSON.stringify(defaultConfig())).not.toContain('model')
  })
})

describe('Treasury limits in the config', () => {
  const base = defaultConfig()
  const bare = guildConfig.parse(
    Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'treasury'))
  )
  const withTreasury = (over: Partial<ReturnType<typeof guildTreasury>>): GuildConfig => ({
    ...base,
    treasury: { ...guildTreasury(base), ...over },
  })

  test('a guild without limits gets the paper defaults: $10/day, $5 Treasurer, 30% reserve, 40% reinvest', () => {
    expect(guildTreasury(bare)).toEqual({
      dailyCapCents: 1000,
      treasurerLimitCents: 500,
      reservePercent: 30,
      reinvestPercent: 40,
    })
    expect(guildConfig.safeParse(base).success).toBe(true)
  })

  test('raising the daily cap or the Treasurer limit is widening', () => {
    expect(classifyChange(base, withTreasury({ dailyCapCents: 1001 }))).toBe('widening')
    expect(classifyChange(base, withTreasury({ treasurerLimitCents: 501 }))).toBe('widening')
  })

  test('lowering the reserve share or the reinvest share is widening, raising it is tightening', () => {
    expect(classifyChange(base, withTreasury({ reservePercent: 29 }))).toBe('widening')
    expect(classifyChange(base, withTreasury({ reinvestPercent: 39 }))).toBe('widening')
    expect(classifyChange(base, withTreasury({ reservePercent: 31 }))).toBe('tightening')
  })

  test('lowering a limit is tightening, and an unchanged or implicit default is neutral', () => {
    expect(classifyChange(base, withTreasury({ dailyCapCents: 0 }))).toBe('tightening')
    expect(classifyChange(base, withTreasury({ treasurerLimitCents: 100 }))).toBe('tightening')
    expect(classifyChange(base, bare)).toBe('neutral')
  })

  test('an unknown Treasury field fails closed as widening', () => {
    const sneaky = { ...base, treasury: { ...guildTreasury(base), spendAnything: true } }
    expect(classifyChange(base, sneaky as GuildConfig)).toBe('widening')
  })
})

describe('learning repo allowlist', () => {
  const base = defaultConfig()
  const withRepos = (learningRepos: string[]) => ({ ...base, learningRepos })

  test('holds owner/name entries only and defaults to none', () => {
    expect(learningRepoAllowlist(base)).toEqual([])
    expect(guildConfig.safeParse(withRepos(['tula-solutions/guildhall'])).success).toBe(true)
    for (const bad of ['guildhall', '../x', 'a/b/c', 'o/ r', 'https://github.com/o/r', '/o/r']) {
      expect(guildConfig.safeParse(withRepos([bad])).success).toBe(false)
    }
  })

  test('adding a repo is widening; removing one is tightening', () => {
    expect(classifyChange(base, withRepos(['o/r']))).toBe('widening')
    expect(classifyChange(withRepos(['o/r']), base)).toBe('tightening')
    expect(classifyChange(withRepos(['o/r']), withRepos(['o/r']))).toBe('neutral')
  })

  test('matching ignores case, as GitHub does', () => {
    const config = withRepos(['Tula-Solutions/Guildhall'])
    expect(isLearningRepoAllowed(config, 'tula-solutions/guildhall')).toBe(true)
    expect(isLearningRepoAllowed(withRepos(['o/r']), 'o/r2')).toBe(false)
    expect(isLearningRepoAllowed(base, 'o/r')).toBe(false)
  })
})

describe('content policy', () => {
  const base = defaultConfig()
  const policy = { maxLength: 500, bannedTerms: ['free money'], requiredTerms: ['guildhall'] }
  const withPolicy = (contentPolicy: typeof policy) => ({ ...base, contentPolicy })

  test('defaults when absent, and is read from the config when set', () => {
    expect(guildContentPolicy(base)).toEqual({
      maxLength: 3000,
      bannedTerms: [],
      requiredTerms: [],
    })
    expect(guildContentPolicy(withPolicy(policy))).toEqual(policy)
  })

  test('tightening: a lower length, more banned terms, more required terms', () => {
    expect(classifyChange(withPolicy(policy), withPolicy({ ...policy, maxLength: 400 }))).toBe(
      'tightening'
    )
    expect(
      classifyChange(
        withPolicy(policy),
        withPolicy({ ...policy, bannedTerms: ['free money', 'x'] })
      )
    ).toBe('tightening')
    expect(
      classifyChange(
        withPolicy(policy),
        withPolicy({ ...policy, requiredTerms: ['guildhall', 'y'] })
      )
    ).toBe('tightening')
  })

  test('loosening is widening: a longer limit, a banned or required term dropped', () => {
    expect(classifyChange(withPolicy(policy), withPolicy({ ...policy, maxLength: 501 }))).toBe(
      'widening'
    )
    expect(classifyChange(withPolicy(policy), withPolicy({ ...policy, bannedTerms: [] }))).toBe(
      'widening'
    )
    expect(classifyChange(withPolicy(policy), withPolicy({ ...policy, requiredTerms: [] }))).toBe(
      'widening'
    )
    expect(classifyChange(withPolicy(policy), base)).toBe('widening')
  })

  test('allowing meta-drafts is widening, and forbidding them again is tightening', () => {
    const allowing = { ...base, contentPolicy: { ...policy, allowMetaDrafts: true } }
    expect(classifyChange(withPolicy(policy), allowing)).toBe('widening')
    expect(classifyChange(allowing, withPolicy(policy))).toBe('tightening')
    expect(guildConfig.safeParse(allowing).success).toBe(true)
  })

  test('an unchanged policy is neutral, and an unknown policy field fails closed', () => {
    expect(classifyChange(withPolicy(policy), withPolicy({ ...policy }))).toBe('neutral')
    const extra = { ...base, contentPolicy: { ...policy, allowLinks: true } }
    expect(classifyChange(withPolicy(policy), extra)).toBe('widening')
  })
})

describe('Member look overrides', () => {
  const base = defaultConfig()
  const look = { body: 1, outfitStyle: 3, outfitColor: 2, hairStyle: 1, hairColor: 5 }
  const withLook = (value: unknown): unknown => ({
    ...base,
    halls: base.halls.map((h) =>
      h.id === 'heralds'
        ? { ...h, members: h.members.map((m, i) => (i === 0 ? { ...m, look: value } : m)) }
        : h
    ),
  })

  test('a look is kept when the config parses, and setting or changing it is neutral', () => {
    const set = guildConfig.parse(withLook(look))
    expect(set.halls[0]?.members[0]).toMatchObject({ look })
    expect(classifyChange(base, set)).toBe('neutral')
    const changed = guildConfig.parse(withLook({ ...look, hairColor: 0 }))
    expect(classifyChange(set, changed)).toBe('neutral')
  })

  test('a look naming a part outside the catalogue is refused', () => {
    expect(guildConfig.safeParse(withLook({ ...look, outfitStyle: 99 })).success).toBe(false)
    expect(guildConfig.safeParse(withLook({ ...look, cape: 1 })).success).toBe(false)
    expect(guildConfig.safeParse(withLook({ ...look, body: -1 })).success).toBe(false)
  })
})

describe('strict on write, tolerant on read', () => {
  const stray = { ...defaultConfig(), caps: { ...defaultConfig().caps, legacyCap: 1 }, extra: 1 }

  test('the write schema rejects unknown keys at every level, naming each path', () => {
    const out = guildConfig.safeParse(stray)
    expect(out.success).toBe(false)
    const keys = out.success
      ? []
      : out.error.issues.flatMap((i) =>
          i.code === 'unrecognized_keys' ? i.keys.map((k) => [...i.path, k].join('.')) : []
        )
    expect(keys.sort()).toEqual(['caps.legacyCap', 'extra'])
  })

  test('a stored config with unknown keys still parses, drops them and warns with their paths', () => {
    const warnings: string[] = []
    const out = parseStoredConfig(stray, (w) => warnings.push(w))
    expect(out).toEqual(defaultConfig())
    expect(warnings.join(' ')).toContain('caps.legacyCap')
    expect(warnings.join(' ')).toContain('extra')
  })

  test('a stored config with a real error still fails', () => {
    expect(() => parseStoredConfig({ ...defaultConfig(), sealPolicy: 'nope' })).toThrow()
  })
})
