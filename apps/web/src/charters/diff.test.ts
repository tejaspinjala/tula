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
    { label: 'sealPolicy', from: 'always', to: 'strict' },
    { label: 'caps.dailyTokens', from: '5', to: '9' },
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
