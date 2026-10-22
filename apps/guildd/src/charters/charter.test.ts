import { describe, expect, test } from 'bun:test'
import { type GuildConfig, guildConfig, hall, provider } from '../guild-config'
import type { RiteGraph } from '../rites/graph'
import {
  applyCharter,
  CONFIG_FIELD_CLASS,
  type ExportRite,
  exportCharter,
  HALL_FIELD_CLASS,
  PROVIDER_FIELD_CLASS,
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
