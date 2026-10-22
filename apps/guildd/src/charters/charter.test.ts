import { describe, expect, test } from 'bun:test'
import {
  caps,
  contentPolicy,
  type GuildConfig,
  guildConfig,
  hall,
  member,
  provider,
  routingProfile,
  schedule,
  treasuryLimits,
  tripwireThresholds,
} from '../guild-config'
import type { RiteGraph } from '../rites/graph'
import {
  AGENT_FIELD_CLASS,
  applyCharter,
  CAPS_FIELD_CLASS,
  CHARTER_MAX_BYTES,
  CONFIG_FIELD_CLASS,
  CONTENT_POLICY_FIELD_CLASS,
  type ExportRite,
  exportCharter,
  HALL_FIELD_CLASS,
  MEMBER_FIELD_CLASS,
  PROVIDER_FIELD_CLASS,
  parseCharter,
  ROUTING_PROFILE_FIELD_CLASS,
  SCHEDULE_FIELD_CLASS,
  TREASURY_FIELD_CLASS,
  TRIPWIRES_FIELD_CLASS,
} from './charter'

const baseHall = { locked: false, privateEligible: true, captain: null, members: [] }

const config: GuildConfig = guildConfig.parse({
  steward: { id: 'steward', name: 'Steward' },
  halls: [
    { id: 'work', name: 'Work', kind: 'work', ...baseHall },
    { id: 'health', name: 'Health', kind: 'private', ...baseHall },
  ],
  sealPolicy: 'always',
  caps: { dailyTokens: 1000, dailySpendCents: 100 },
  providers: [{ id: 'claude', auth: 'subscription', privateEligible: true }],
  routingProfiles: [],
  schedules: [],
  learningRepos: ['me/repo'],
})

const graphFor = (hallId: string): RiteGraph => ({
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    {
      id: 'do',
      type: 'agent',
      hallId,
      templateId: 't',
      briefTemplate: 'b',
      doneCondition: 'd',
      maxUsd: 1,
    },
  ],
  edges: [{ from: 'start', to: 'do' }],
})

const rite = (id: string, over: Partial<ExportRite> = {}): ExportRite => ({
  id,
  name: id,
  archivedAt: null,
  activeGraph: graphFor('work'),
  ...over,
})

const now = new Date('2026-01-01T00:00:00.000Z')

describe('exportCharter', () => {
  test('strips privateEligible and learningRepos and lists learningRepos as omitted', () => {
    const c = exportCharter({ name: 'n', config, rites: [], now })
    expect(c.config.halls.every((h) => h.privateEligible === false)).toBe(true)
    expect(c.config.providers.every((p) => p.privateEligible === false)).toBe(true)
    expect(c.config.learningRepos).toBeUndefined()
    expect(c.omitted).toContainEqual({ kind: 'config', id: 'learningRepos', reason: 'local' })
    expect(c.exportedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  test('drops archived, unpublished and private-Hall Rites, each listed in omitted', () => {
    const c = exportCharter({
      name: 'n',
      config,
      now,
      rites: [
        rite('ok'),
        rite('old', { archivedAt: '2025-01-01T00:00:00.000Z' }),
        rite('draft', { activeGraph: null }),
        rite('secret', { activeGraph: graphFor('health') }),
      ],
    })
    expect(c.rites.map((r) => r.name)).toEqual(['ok'])
    expect(c.omitted.filter((o) => o.kind === 'rite')).toEqual([
      { kind: 'rite', id: 'old', reason: 'archived' },
      { kind: 'rite', id: 'draft', reason: 'unpublished' },
      { kind: 'rite', id: 'secret', reason: 'private_hall' },
    ])
  })
})

describe('applyCharter', () => {
  const charter = exportCharter({ name: 'n', config, rites: [rite('ok')], now })
  const current: GuildConfig = {
    ...config,
    halls: config.halls.filter((h) => h.id === 'work'),
    learningRepos: ['mine/keep'],
  }

  test('keeps current local fields and defaults new ids to false', () => {
    const r = applyCharter({ charter, current, existingRiteNames: [] })
    if (!r.ok) {
      throw new Error('expected ok')
    }
    expect(r.config.learningRepos).toEqual(['mine/keep'])
    expect(r.config.halls.find((h) => h.id === 'work')?.privateEligible).toBe(true)
    expect(r.config.halls.find((h) => h.id === 'health')?.privateEligible).toBe(false)
    expect(r.config.providers[0]?.privateEligible).toBe(true)
  })

  test('never trusts privateEligible from the charter', () => {
    const tampered = {
      ...charter,
      config: {
        ...charter.config,
        halls: charter.config.halls.map((h) => ({ ...h, privateEligible: true })),
      },
    }
    const r = applyCharter({
      charter: tampered,
      current: { ...current, halls: [] },
      existingRiteNames: [],
    })
    if (!r.ok) {
      throw new Error('expected ok')
    }
    expect(r.config.halls.every((h) => !h.privateEligible)).toBe(true)
  })

  test('rejects a Rite node naming a Hall absent from the config', () => {
    const bad = { ...charter, rites: [{ name: 'x', graph: graphFor('nowhere') }] }
    const r = applyCharter({ charter: bad, current, existingRiteNames: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('invalid_charter')
    }
  })

  test('suffixes names already in use deterministically', () => {
    const two = {
      ...charter,
      rites: [
        { name: 'ok', graph: graphFor('work') },
        { name: 'ok', graph: graphFor('work') },
      ],
    }
    const r = applyCharter({ charter: two, current, existingRiteNames: ['ok', 'ok (2)'] })
    if (!r.ok) {
      throw new Error('expected ok')
    }
    expect(r.drafts.map((d) => d.name)).toEqual(['ok (3)', 'ok (4)'])
  })
})

describe('field classification', () => {
  test('classifies every guildConfig, Hall and provider key', () => {
    expect(Object.keys(CONFIG_FIELD_CLASS).sort()).toEqual(Object.keys(guildConfig.shape).sort())
    expect(Object.keys(HALL_FIELD_CLASS).sort()).toEqual(Object.keys(hall.shape).sort())
    expect(Object.keys(PROVIDER_FIELD_CLASS).sort()).toEqual(Object.keys(provider.shape).sort())
  })
})

describe('parseCharter', () => {
  test('round-trips an exported Charter', () => {
    const c = exportCharter({ name: 'n', config, rites: [rite('ok')], now })
    const r = parseCharter(JSON.stringify(c))
    expect(r.ok).toBe(true)
  })

  test('refuses a document over the size cap and more than 50 Rites', () => {
    expect(parseCharter(' '.repeat(CHARTER_MAX_BYTES + 1)).ok).toBe(false)
    const many = exportCharter({ name: 'n', config, rites: [], now })
    const over = {
      ...many,
      rites: Array.from({ length: 51 }, () => ({ name: 'r', graph: graphFor('work') })),
    }
    expect(parseCharter(JSON.stringify(over)).ok).toBe(false)
  })
})

const keys = (o: object) => Object.keys(o).sort()

describe('nested field classification (F1)', () => {
  test('classifies every nested object key', () => {
    expect(keys(MEMBER_FIELD_CLASS)).toEqual(keys(member.shape))
    expect(keys(AGENT_FIELD_CLASS)).toEqual(keys(guildConfig.shape.steward.shape))
    expect(keys(CAPS_FIELD_CLASS)).toEqual(keys(caps.shape))
    expect(keys(TREASURY_FIELD_CLASS)).toEqual(keys(treasuryLimits.shape))
    expect(keys(TRIPWIRES_FIELD_CLASS)).toEqual(keys(tripwireThresholds.shape))
    expect(keys(CONTENT_POLICY_FIELD_CLASS)).toEqual(keys(contentPolicy.shape))
    expect(keys(ROUTING_PROFILE_FIELD_CLASS)).toEqual(keys(routingProfile.shape))
    expect(keys(SCHEDULE_FIELD_CLASS)).toEqual(keys(schedule.shape))
  })

  test('every local key is absent or false after export', () => {
    const c = exportCharter({ name: 'n', config, rites: [], now })
    for (const [k, cls] of Object.entries(CONFIG_FIELD_CLASS)) {
      if (cls === 'local') {
        expect(c.config).not.toHaveProperty(k)
      }
    }
    for (const h of c.config.halls) {
      for (const [k, cls] of Object.entries(HALL_FIELD_CLASS)) {
        if (cls === 'local') {
          expect(h[k as keyof typeof h]).toBeFalsy()
        }
      }
    }
    for (const p of c.config.providers) {
      for (const [k, cls] of Object.entries(PROVIDER_FIELD_CLASS)) {
        if (cls === 'local') {
          expect(p[k as keyof typeof p]).toBeFalsy()
        }
      }
    }
  })
})

describe('export fails closed (F2)', () => {
  test('a Hall with an extra runtime key is not exported', () => {
    const dirty = {
      ...config,
      halls: config.halls.map((h) => ({ ...h, secretNote: 'x' })),
    }
    expect(() => exportCharter({ name: 'n', config: dirty, rites: [], now })).toThrow()
  })
})

describe('apply tamper cases (F3)', () => {
  const charter = exportCharter({ name: 'n', config, rites: [], now })
  const closed: GuildConfig = {
    ...config,
    halls: config.halls.map((h) => ({ ...h, privateEligible: false })),
    providers: config.providers.map((p) => ({ ...p, privateEligible: false })),
    learningRepos: undefined,
  }
  const tampered = {
    ...charter,
    config: {
      ...charter.config,
      halls: charter.config.halls.map((h) => ({ ...h, privateEligible: true })),
      providers: charter.config.providers.map((p) => ({ ...p, privateEligible: true })),
      learningRepos: ['evil/x'],
    },
  }

  test('an existing Hall and provider false in current stay false, learningRepos not taken', () => {
    const r = applyCharter({ charter: tampered, current: closed, existingRiteNames: [] })
    if (!r.ok) {
      throw new Error('expected ok')
    }
    expect(r.config.halls.every((h) => h.privateEligible === false)).toBe(true)
    expect(r.config.providers.every((p) => p.privateEligible === false)).toBe(true)
    expect(r.config.learningRepos).toBeUndefined()
  })
})

describe('parseCharter byte cap (F4)', () => {
  test('refuses multibyte text whose length is under the cap but bytes are over', () => {
    const text = '€'.repeat(Math.ceil(CHARTER_MAX_BYTES / 3) + 1)
    expect(text.length).toBeLessThan(CHARTER_MAX_BYTES)
    const r = parseCharter(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('size')
    }
  })

  test('accepts a document exactly at the cap', () => {
    const json = JSON.stringify(exportCharter({ name: 'n', config, rites: [], now }))
    const padded = json + ' '.repeat(CHARTER_MAX_BYTES - json.length)
    expect(new TextEncoder().encode(padded).length).toBe(CHARTER_MAX_BYTES)
    expect(parseCharter(padded).ok).toBe(true)
  })
})

describe('private-Hall Rite omission (F5)', () => {
  const sub: RiteGraph = {
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      {
        id: 's',
        type: 'subagents',
        hallId: 'health',
        templateId: 't',
        briefs: ['b'],
        join: 'all',
        maxUsd: 1,
      },
    ],
    edges: [{ from: 'start', to: 's' }],
  }
  const team: RiteGraph = {
    nodes: [
      { id: 'start', type: 'trigger.manual' },
      {
        id: 't',
        type: 'team',
        hallId: 'health',
        goal: 'g',
        maxMembers: 1,
        maxQuests: 1,
        maxUsd: 1,
      },
    ],
    edges: [{ from: 'start', to: 't' }],
  }
  const mixed: RiteGraph = {
    nodes: [...graphFor('work').nodes, ...team.nodes.slice(1)],
    edges: [],
  }

  test('subagents, team, mixed and unknown-Hall Rites are omitted with the right reason', () => {
    const c = exportCharter({
      name: 'n',
      config,
      now,
      rites: [
        rite('sub', { activeGraph: sub }),
        rite('team', { activeGraph: team }),
        rite('mixed', { activeGraph: mixed }),
        rite('ghost', { activeGraph: graphFor('nowhere') }),
      ],
    })
    expect(c.rites).toEqual([])
    expect(c.omitted.filter((o) => o.kind === 'rite')).toEqual([
      { kind: 'rite', id: 'sub', reason: 'private_hall' },
      { kind: 'rite', id: 'team', reason: 'private_hall' },
      { kind: 'rite', id: 'mixed', reason: 'private_hall' },
      { kind: 'rite', id: 'ghost', reason: 'unknown_hall' },
    ])
  })
})

describe('schedule triggers (F6)', () => {
  test('apply rejects a Rite whose scheduleId is not in the config schedules', () => {
    const graph: RiteGraph = {
      nodes: [
        { id: 'tick', type: 'trigger.schedule', scheduleId: 'nightly' },
        ...graphFor('work').nodes.slice(1),
      ],
      edges: [],
    }
    const charter = exportCharter({
      name: 'n',
      config,
      rites: [rite('s', { activeGraph: graph })],
      now,
    })
    const r = applyCharter({ charter, current: config, existingRiteNames: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('invalid_charter')
    }
  })
})
describe('the tables drive behaviour (F1)', () => {
  test('a table passed in marks a key local: removed on export, restored from current on apply', () => {
    const withPolicy: GuildConfig = {
      ...config,
      contentPolicy: { maxLength: 100, bannedTerms: [], requiredTerms: [] },
    }
    const tables = {
      config: { ...CONFIG_FIELD_CLASS, contentPolicy: 'local' as const },
      hall: HALL_FIELD_CLASS,
      provider: PROVIDER_FIELD_CLASS,
    }
    const c = exportCharter({ name: 'n', config: withPolicy, rites: [], now, tables })
    expect(c.config.contentPolicy).toBeUndefined()
    const r = applyCharter({ charter: c, current: withPolicy, existingRiteNames: [], tables })
    if (!r.ok) {
      throw new Error('expected ok')
    }
    expect(r.config.contentPolicy).toEqual(withPolicy.contentPolicy)
  })
})

describe('nested tables are structure-only', () => {
  // These tables exist only to force a classification decision when a nested key is added.
  // A nested `local` key needs export support first, so every value must be `structure`.
  test('every value in the eight nested tables is structure', () => {
    const nested = [
      MEMBER_FIELD_CLASS,
      AGENT_FIELD_CLASS,
      CAPS_FIELD_CLASS,
      TREASURY_FIELD_CLASS,
      TRIPWIRES_FIELD_CLASS,
      CONTENT_POLICY_FIELD_CLASS,
      ROUTING_PROFILE_FIELD_CLASS,
      SCHEDULE_FIELD_CLASS,
    ]
    for (const table of nested) {
      expect(Object.values(table).every((v) => v === 'structure')).toBe(true)
    }
  })
})

describe('schedule triggers (F3)', () => {
  test('apply accepts a schedule trigger whose scheduleId is in config.schedules', () => {
    const withSchedule: GuildConfig = {
      ...config,
      schedules: [{ id: 'nightly', cron: '0 0 * * *' }],
    }
    const graph: RiteGraph = {
      nodes: [
        { id: 'tick', type: 'trigger.schedule', scheduleId: 'nightly' },
        ...graphFor('work').nodes.slice(1),
      ],
      edges: [],
    }
    const charter = exportCharter({
      name: 'n',
      config: withSchedule,
      rites: [rite('s', { activeGraph: graph })],
      now,
    })
    const r = applyCharter({ charter, current: withSchedule, existingRiteNames: [] })
    expect(r.ok).toBe(true)
  })
})
