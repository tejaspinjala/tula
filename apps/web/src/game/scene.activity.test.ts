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

const quests = [{ id: 'q1', title: 'Write the brief', hallId: 'h-herald', ownerId: 'm2' }]
const claimed: ReplayEvent = {
  seq: 0,
  type: 'quest.claimed',
  payload: { questId: 'q1', hallId: 'h-herald' },
  occurredAt: '2026-10-20T10:00:00Z',
}
const derive = (events: ReplayEvent[], upTo: number | null = null) =>
  deriveScene({ roster, quests, events, upTo })

test('a working Member carries the latest activity of their Quest and the seq it began at', () => {
  const later: ReplayEvent = {
    ...activity,
    seq: 2,
    payload: { ...(activity.payload as object), activity: 'writing' },
  }
  const scene = derive([claimed, activity, later])
  expect(scene.members.m2?.activity).toEqual({ name: 'writing', seq: 2 })
  expect(derive([claimed, activity, later], 1).members.m2?.activity).toEqual({
    name: 'reading_archive',
    seq: 1,
  })
})

test('an activity of a Member who holds no active Quest is ignored', () => {
  expect(derive([activity]).members.m2?.activity).toBeUndefined()
})

test('a Member whose Quest awaits a Seal is marked, and a finished Quest leaves its seq', () => {
  const awaiting: ReplayEvent = {
    seq: 3,
    type: 'quest.awaiting_seal',
    payload: { questId: 'q1' },
    occurredAt: '2026-10-20T10:00:03Z',
  }
  const done: ReplayEvent = { ...awaiting, seq: 4, type: 'quest.done' }
  expect(derive([claimed, awaiting]).members.m2?.awaitingSeal).toBe(true)
  const finished = derive([claimed, activity, awaiting, done]).members.m2
  expect(finished?.doneSeq).toBe(4)
  expect(finished?.awaitingSeal).toBeUndefined()
  expect(finished?.activity).toBeUndefined()
})

test('the web activity list is the one guildd emits', () => {
  expect([...ACTIVITIES]).toEqual([...GUILDD_ACTIVITIES])
})
