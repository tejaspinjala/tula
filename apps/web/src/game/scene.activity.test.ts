import { expect, test } from 'bun:test'
import { ACTIVITIES as GUILDD_ACTIVITIES } from '../../../guildd/src/ports/activity-log'
import type { ReplayEvent } from '../replay'
import { ACTIVITIES, deriveScene, memberActivityPayload, type SceneRoster } from './scene'

const roster: SceneRoster = {
  steward: { id: 's1', name: 'Steward' },
  halls: [
    {
      id: 'h-herald',
      name: 'Heralds',
      kind: 'work',
      locked: false,
      captain: null,
      members: [{ id: 'm2', name: 'Bram', rank: 'member' }],
    },
  ],
}
const activity: ReplayEvent = {
  seq: 1,
  type: 'member.activity',
  payload: { questId: 'q1', memberId: 'm2', hallId: 'h-herald', activity: 'reading_archive' },
  occurredAt: '2026-10-20T10:00:01Z',
}

test('the payload schema accepts ids and a known activity, and refuses extra text or an unknown activity', () => {
  expect(memberActivityPayload.safeParse(activity.payload).success).toBe(true)
  expect(
    memberActivityPayload.safeParse({ ...(activity.payload as object), text: 'x' }).success
  ).toBe(false)
  expect(
    memberActivityPayload.safeParse({ ...(activity.payload as object), activity: 'dancing' })
      .success
  ).toBe(false)
})

test('the reducer accepts a member.activity event and changes nothing yet', () => {
  const base = deriveScene({ roster, quests: [], events: [], upTo: null })
  const withEvent = deriveScene({ roster, quests: [], events: [activity], upTo: null })
  expect(withEvent).toEqual({ ...base, appliedSeq: 1 })
})

test('the web activity list is the one guildd emits', () => {
  expect([...ACTIVITIES]).toEqual([...GUILDD_ACTIVITIES])
})
