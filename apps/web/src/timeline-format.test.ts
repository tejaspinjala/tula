import { expect, test } from 'bun:test'
import { describeEvent } from './event-text'
import { groupRepeats, relativeTime, stateWord } from './timeline-format'

const now = Date.parse('2026-03-01T12:00:00.000Z')
const ago = (ms: number) => new Date(now - ms).toISOString()

test('relative times read as words', () => {
  expect(relativeTime(ago(10_000), now)).toBe('just now')
  expect(relativeTime(ago(60_000), now)).toBe('1 minute ago')
  expect(relativeTime(ago(5 * 60_000), now)).toBe('5 minutes ago')
  expect(relativeTime(ago(2 * 3_600_000), now)).toBe('2 hours ago')
  expect(relativeTime(ago(3 * 86_400_000), now)).toBe('3 days ago')
  expect(relativeTime('not a date', now)).toBe('not a date')
})

test('consecutive repeats group into one row with a count', () => {
  const rows = [
    { text: 'Guild Master signed in', at: 1 },
    { text: 'Guild Master signed in', at: 2 },
    { text: 'Treasury entry: seed', at: 3 },
    { text: 'Guild Master signed in', at: 4 },
  ]
  expect(groupRepeats(rows).map((r) => [r.text, r.count, r.at])).toEqual([
    ['Guild Master signed in', 2, 2],
    ['Treasury entry: seed', 1, 3],
    ['Guild Master signed in', 1, 4],
  ])
})

test('state keys read as words', () => {
  expect(stateWord('awaiting_seal')).toBe('awaiting Seal')
  expect(stateWord('consumed')).toBe('posted')
  expect(stateWord('dead')).toBe('dead-lettered')
  expect(stateWord('council_approved')).toBe('approved by the Council')
  expect(stateWord('queued')).toBe('queued')
})

test('event text names a Quest by its title when the log lists it', () => {
  const event = {
    seq: 1,
    type: 'handoff.recorded',
    payload: { quest_id: 'q1', attempt: 1, handoff_hash: 'h' },
    occurredAt: ago(0),
  }
  expect(describeEvent(event, { q1: 'Announce run check' })).toBe(
    'Handoff recorded for Quest Announce run check'
  )
  expect(describeEvent(event)).toBe('Handoff recorded for Quest q1')
})
