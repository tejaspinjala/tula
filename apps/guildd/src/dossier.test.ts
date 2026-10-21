import { describe, expect, test } from 'bun:test'
import { assembleDossier, type DossierRecords } from './dossier'
import { type Handoff, hashHandoff } from './ports/handoff-store'
import { hashBytes } from './ports/object-store'

const bytes = new TextEncoder().encode('the artifact')
const A = hashBytes(bytes)
const B = hashBytes(new TextEncoder().encode('another'))

const handoff: Handoff = {
  goal: 'Ship the thing',
  doneCondition: 'The thing ships',
  met: true,
  evidence: [{ kind: 'artifact', ref: A }],
  openItems: [],
  artifacts: [A],
}

function records(over: Partial<DossierRecords> = {}): DossierRecords {
  return {
    questId: 'q-1',
    hallId: 'heralds',
    handoff,
    handoffHash: hashHandoff(handoff),
    verdict: { proposalHash: 'p'.repeat(64), passed: true, findingCount: 0 },
    seal: { status: 'consumed', actionHash: 's'.repeat(64) },
    ...over,
  }
}

const present = new Map([[A, { actualHash: A, size: bytes.length }]])

describe('assembleDossier', () => {
  test('stored records whose hashes all re-check make a verified Dossier', () => {
    const d = assembleDossier(records(), present)
    expect(d.verified).toBe(true)
    expect(d.failedChecks).toEqual([])
    expect(d.body).toMatchObject({
      questId: 'q-1',
      hallId: 'heralds',
      goal: 'Ship the thing',
      doneCondition: 'The thing ships',
      handoffHash: hashHandoff(handoff),
      artifacts: [{ hash: A, size: bytes.length }],
      verdict: { passed: true },
      seal: { status: 'consumed' },
    })
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the same records always give the same Dossier hash, and different records another', () => {
    const one = assembleDossier(records(), present).hash
    expect(assembleDossier(records(), present).hash).toBe(one)
    expect(assembleDossier(records({ seal: null }), present).hash).not.toBe(one)
  })

  test('a Handoff whose stored hash no longer matches is named as a failed check', () => {
    const d = assembleDossier(records({ handoffHash: 'f'.repeat(64) }), present)
    expect(d.verified).toBe(false)
    expect(d.failedChecks).toEqual(['handoff_hash_mismatch'])
  })

  test('an artifact the ObjectStore does not hold is named by its hash', () => {
    const d = assembleDossier(records(), new Map([[A, null]]))
    expect(d.verified).toBe(false)
    expect(d.failedChecks).toEqual([`artifact_missing:${A}`])
    expect(d.body.artifacts).toEqual([{ hash: A, size: null }])
  })

  test('an artifact whose bytes hash to something else is a mismatch', () => {
    const d = assembleDossier(records(), new Map([[A, { actualHash: B, size: 3 }]]))
    expect(d.verified).toBe(false)
    expect(d.failedChecks).toEqual([`artifact_hash_mismatch:${A}`])
  })

  test('an artifact cited only as evidence is checked too, and an unobserved one counts as missing', () => {
    const h: Handoff = { ...handoff, artifacts: [], evidence: [{ kind: 'artifact', ref: B }] }
    const d = assembleDossier(records({ handoff: h, handoffHash: hashHandoff(h) }), present)
    expect(d.failedChecks).toEqual([`artifact_missing:${B}`])
  })

  test('every failed check is listed, not only the first', () => {
    const h: Handoff = { ...handoff, artifacts: [A, B] }
    const d = assembleDossier(
      records({ handoff: h, handoffHash: 'f'.repeat(64) }),
      new Map([
        [A, null],
        [B, { actualHash: A, size: 1 }],
      ])
    )
    expect(d.failedChecks).toEqual([
      'handoff_hash_mismatch',
      `artifact_missing:${A}`,
      `artifact_hash_mismatch:${B}`,
    ])
  })
})
