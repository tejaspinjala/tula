import { expect, test } from 'bun:test'
import { FIELD_LABELS } from './Inspector'

test('the team ceilings are labelled as save-time checks against the guild caps, not per-run limits', () => {
  expect(FIELD_LABELS.maxMembers).toBe('Member ceiling (checked against the Hall cap when saved)')
  expect(FIELD_LABELS.maxQuests).toBe('Quest ceiling (checked against the Campaign cap when saved)')
})
