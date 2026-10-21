import { expect, test } from 'bun:test'
import { type Quest, QuestError, retryDelayMs, submitTransition } from './quest-queue'

const active: Quest = {
  id: '00000000-0000-4000-8000-000000000001',
  seq: 1,
  jobKey: 'k',
  campaignId: null,
  board: false,
  templateId: 't',
  hallId: 'heralds',
  rank: 'apprentice',
  dataClass: 'internal',
  title: 'T',
  ownerId: 'm',
  doneCondition: 'd',
  state: 'active',
  round: 2,
  roundLimit: 2,
  blockedBy: [],
  waitingOn: [],
  waitMode: 'all',
  attempts: 1,
  maxAttempts: 3,
  refunds: 0,
  leaseExpiresAt: '2030-01-01T00:00:00.000Z',
  notBefore: '2030-01-01T00:00:00.000Z',
  lastError: null,
  createdAt: '2030-01-01T00:00:00.000Z',
}

test('a Quest whose rounds are spent cannot be submitted for another Seal', () => {
  expect(() => submitTransition(active, 1)).toThrow(QuestError)
  expect(() => submitTransition(active, 1)).toThrow('round_limit')
})

test('retry delay is exponential, capped, and jittered between half and full', () => {
  expect(retryDelayMs(1, 0)).toBe(500)
  expect(retryDelayMs(1, 1)).toBe(1000)
  expect(retryDelayMs(3, 0.5)).toBe(3000)
  expect(retryDelayMs(30, 1)).toBe(300_000)
})
