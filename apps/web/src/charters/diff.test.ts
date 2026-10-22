import { expect, test } from 'bun:test'
import { parseConfig } from '../builder/model'
import { previewCharter } from './diff'
import { sampleCharter } from './fixtures'

const hall = (id: string, name: string, privateEligible = false) => ({
  id,
  name,
  kind: 'work',
  locked: false,
  privateEligible,
  captain: null,
  members: [],
})
const current = parseConfig({
  steward: { id: 'steward', name: 'Steward' },
  halls: [hall('heralds', 'Heralds Hall', true), hall('health', 'Health')],
  sealPolicy: 'always',
  caps: { dailyTokens: 5, maxSpawnDepth: 2 },
  learningRepos: ['me/repo'],
})

test('the preview lists Halls added and removed by name', () => {
  const p = previewCharter(current, sampleCharter)
  expect(p.hallsAdded).toEqual(['Forge'])
  expect(p.hallsRemoved).toEqual(['Health'])
})

test('the preview lists the Seal Policy and changed caps only', () => {
  const p = previewCharter(current, sampleCharter)
  expect(p.settings).toEqual([
    { label: 'caps.dailyTokens', from: '5', to: '9' },
    { label: 'sealPolicy', from: 'always', to: 'strict' },
  ])
})

test('the preview names the Rites to add as drafts', () => {
  expect(previewCharter(current, sampleCharter).ritesAdded).toEqual(['Morning digest'])
})

test('the preview lists the fields kept from this guild', () => {
  const kept = previewCharter(current, sampleCharter).kept.join(' | ')
  expect(kept).toContain('learningRepos')
  expect(kept).toContain('Heralds Hall')
})

test('an identical config shows no changes', () => {
  const same = previewCharter(current, { ...sampleCharter, config: current, rites: [] })
  expect(same.hallsAdded).toEqual([])
  expect(same.settings).toEqual([])
})

const twin = (config: unknown) => ({ ...sampleCharter, config: parseConfig(config), rites: [] })
const base = {
  steward: { id: 'steward', name: 'Steward' },
  halls: [hall('heralds', 'Heralds Hall')],
  sealPolicy: 'always',
  caps: { dailyTokens: 5, maxSpawnDepth: 2 },
  providers: [{ id: 'p1', auth: 'key' }],
}

test('a Charter that only locks a Hall gives a non-empty preview', () => {
  const locked = { ...base, halls: [{ ...hall('heralds', 'Heralds Hall'), locked: true }] }
  const p = previewCharter(parseConfig(base), twin(locked))
  expect(p.settings.map((s) => s.label)).toContain('halls.heralds.locked')
})

test('a Charter that only changes a provider auth gives a non-empty preview', () => {
  const next = { ...base, providers: [{ id: 'p1', auth: 'oauth' }] }
  const p = previewCharter(parseConfig(base), twin(next))
  expect(p.settings).toEqual([{ label: 'providers.p1.auth', from: 'key', to: 'oauth' }])
})

test('a Charter that only changes Members gives a non-empty preview', () => {
  const withMember = {
    ...base,
    halls: [
      { ...hall('heralds', 'Heralds Hall'), members: [{ id: 'm', name: 'Mira', rank: 'adept' }] },
    ],
  }
  const p = previewCharter(parseConfig(base), twin(withMember))
  expect(p.settings.map((s) => s.label)).toEqual(['halls.heralds.members'])
})

test('a Charter that only changes the Steward gives a non-empty preview', () => {
  const next = { ...base, steward: { id: 'steward', name: 'Elder' } }
  const p = previewCharter(parseConfig(base), twin(next))
  expect(p.settings.map((s) => s.label)).toEqual(['steward.name'])
})

test('a provider added or removed shows, and privateEligible alone does not', () => {
  const plus = { ...base, providers: [...base.providers, { id: 'p2' }] }
  const added = previewCharter(parseConfig(base), twin(plus))
  expect(added.settings.map((s) => s.label)).toEqual(['providers.p2'])
  const removed = previewCharter(parseConfig(base), twin({ ...base, providers: [] }))
  expect(removed.settings.map((s) => s.label)).toEqual(['providers.p1'])
  const mine = { ...base, providers: [{ id: 'p1', auth: 'key', privateEligible: true }] }
  expect(previewCharter(parseConfig(mine), twin(base)).settings).toEqual([])
})
