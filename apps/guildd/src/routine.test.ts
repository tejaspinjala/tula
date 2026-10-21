import { describe, expect, test } from 'bun:test'
import { isRoutine, type RoutineFacts } from './routine'

const HASH = 'a'.repeat(64)

const verdict = {
  proposalHash: HASH,
  passed: true,
  findings: [],
  checkedAt: '2030-01-01T00:00:00.000Z',
}

/** Facts under which a Proposal is routine; each test breaks exactly one. */
const routine: RoutineFacts = {
  templateRoutineEligible: true,
  dataClass: 'public',
  proposalHash: HASH,
  verdict,
  approvalsRemainingToday: 1,
}

describe('isRoutine', () => {
  test('all four conditions holding is routine', () => {
    expect(isRoutine(routine)).toBe(true)
  })
  test('an internal data class can be routine', () => {
    expect(isRoutine({ ...routine, dataClass: 'internal' })).toBe(true)
  })
  test('a template not marked routine-eligible is not routine', () => {
    expect(isRoutine({ ...routine, templateRoutineEligible: false })).toBe(false)
  })
  test('a private data class is never routine', () => {
    expect(isRoutine({ ...routine, dataClass: 'private' })).toBe(false)
  })
  test('a failing Verdict is not routine', () => {
    expect(isRoutine({ ...routine, verdict: { ...verdict, passed: false } })).toBe(false)
  })
  test('no Verdict is not routine', () => {
    expect(isRoutine({ ...routine, verdict: null })).toBe(false)
  })
  test('a passing Verdict on a different hash is not routine', () => {
    const other = 'b'.repeat(64)
    expect(isRoutine({ ...routine, verdict: { ...verdict, proposalHash: other } })).toBe(false)
  })
  test('no approvals left today (cap at 0) is not routine', () => {
    expect(isRoutine({ ...routine, approvalsRemainingToday: 0 })).toBe(false)
  })
  test('a negative remainder is not routine', () => {
    expect(isRoutine({ ...routine, approvalsRemainingToday: -1 })).toBe(false)
  })
})
