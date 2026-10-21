import { expect, test } from 'bun:test'
import type { ReplayEvent } from '../replay'
import { deriveScene, memberActivityPayload, type SceneRoster } from './scene'

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
    {
      id: 'h-vault',
      name: 'Vaultkeepers',
      kind: 'work',
      locked: false,
      captain: { id: 'v1', name: 'Captain Vera' },
      members: [
        { id: 'v1', name: 'Captain Vera', rank: 'captain' },
        { id: 'v2', name: 'Orin', rank: 'member' },
      ],
    },
  ],
}
let seq = 0
const ev = (type: string, payload: unknown): ReplayEvent => {
  seq += 1
  return { seq, type, payload, occurredAt: `2026-10-20T10:00:${String(seq).padStart(2, '0')}Z` }
}
const derive = (events: ReplayEvent[], missiveTexts?: Record<string, string>) =>
  deriveScene({ roster, quests: [], events, upTo: null, missiveTexts })

test('the activity payload accepts the Hall a cross-Hall activity is aimed at', () => {
  const base = { questId: 'q', memberId: 'm2', hallId: 'h-herald', activity: 'messaging' }
  expect(memberActivityPayload.safeParse({ ...base, toHallId: 'h-vault' }).success).toBe(true)
  expect(memberActivityPayload.safeParse(base).success).toBe(true)
})

test('a cross-Hall activity sends a courier between the two Halls; one inside a Hall does not', () => {
  seq = 0
  const cross = ev('member.activity', {
    questId: 'q',
    memberId: 'm2',
    hallId: 'h-herald',
    activity: 'waiting',
    toHallId: 'h-vault',
  })
  const inside = ev('member.activity', {
    questId: 'q',
    memberId: 'm2',
    hallId: 'h-herald',
    activity: 'writing',
  })
  expect(derive([cross, inside]).couriers).toEqual([
    { seq: 1, fromHall: 'h-herald', toHall: 'h-vault', toMemberId: null },
  ])
})

test('a cross-Hall Missive: the sender carries "To <Hall>:", the addressee "From <Hall>:", and a courier walks', () => {
  seq = 0
  const events = [
    ev('missive.sent', {
      missiveId: 'mv1',
      from: 'm2',
      to: 'v2',
      hall: 'h-herald',
      toHall: 'h-vault',
    }),
  ]
  const scene = derive(events, { mv1: 'Send the ledger.' })
  expect(scene.members.m2?.bubble?.text).toBe('To Vaultkeepers: Send the ledger.')
  expect(scene.members.v2?.bubble?.text).toBe('From Heralds: Send the ledger.')
  expect(scene.members.v1?.bubble).toBeNull()
  expect(scene.couriers).toEqual([
    { seq: 1, fromHall: 'h-herald', toHall: 'h-vault', toMemberId: 'v2' },
  ])
})

test('a cross-Hall Missive to the whole Hall is received by its Captain', () => {
  seq = 0
  const events = [
    ev('missive.sent', {
      missiveId: 'mv1',
      from: 'm2',
      to: 'hall',
      hall: 'h-herald',
      toHall: 'h-vault',
    }),
  ]
  const scene = derive(events, { mv1: 'Hello.' })
  expect(scene.members.v1?.bubble?.text).toBe('From Heralds: Hello.')
})
