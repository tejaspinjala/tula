import { expect, test } from 'bun:test'
import type { ReplayEvent } from '../replay'
import { deriveScene, type SceneQuest, type SceneRoster } from './scene'

const roster: SceneRoster = {
  steward: { id: 's1', name: 'Steward' },
  halls: [
    {
      id: 'h-herald',
      name: 'Heralds',
      kind: 'work',
      locked: false,
      captain: { id: 'm1', name: 'Captain Ada' },
      members: [
        { id: 'm1', name: 'Captain Ada', rank: 'captain' },
        { id: 'm2', name: 'Bram', rank: 'member' },
      ],
    },
    {
      id: 'h-vault',
      name: 'Vaultkeepers',
      kind: 'private',
      locked: true,
      captain: null,
      members: [],
    },
  ],
}
const quests: SceneQuest[] = [
  { id: 'q1', title: 'Write the herald notice', hallId: 'h-herald', ownerId: 'm2' },
]
let seq = 0
function ev(type: string, payload: unknown): ReplayEvent {
  seq += 1
  return { seq, type, payload, occurredAt: `2026-10-20T10:00:${String(seq).padStart(2, '0')}Z` }
}

test('a room per Hall, a Member per Member in their Hall, idle with no Quest, locked Halls closed', () => {
  const scene = deriveScene({ roster, quests, events: [], upTo: null })
  expect(scene.rooms.map((r) => [r.hallId, r.locked, r.memberIds])).toEqual([
    ['h-herald', false, ['m1', 'm2']],
    ['h-vault', true, []],
  ])
  expect(scene.members.m2).toMatchObject({ hallId: 'h-herald', status: 'idle', bubble: null })
  expect(scene.gateClosed).toBe(false)
  expect(scene.coinsCents).toBe(0)
  expect(scene.scrolls).toEqual([])
})

test('a claimed Quest makes its owner work and speak the Quest title', () => {
  seq = 0
  const events = [
    ev('quest.posted', { questId: 'q1', hallId: 'h-herald', attempt: 0 }),
    ev('quest.claimed', { questId: 'q1', hallId: 'h-herald', attempt: 1 }),
  ]
  const scene = deriveScene({ roster, quests, events, upTo: null })
  expect(scene.members.m2).toMatchObject({
    status: 'working',
    questId: 'q1',
    bubble: { text: 'Write the herald notice', seq: 2 },
  })
  expect(scene.members.m1?.status).toBe('idle')
})

test('a Quest awaiting a Seal is a scroll at the Seal desk and its owner stops working', () => {
  seq = 0
  const events = [
    ev('quest.claimed', { questId: 'q1', hallId: 'h-herald', attempt: 1 }),
    ev('quest.awaiting_seal', { questId: 'q1', hallId: 'h-herald', attempt: 1 }),
  ]
  const scene = deriveScene({ roster, quests, events, upTo: null })
  expect(scene.scrolls).toEqual([{ questId: 'q1', title: 'Write the herald notice' }])
  expect(scene.members.m2?.status).toBe('idle')
})

test('a done Quest clears work and bubble', () => {
  seq = 0
  const events = [
    ev('quest.claimed', { questId: 'q1', hallId: 'h-herald', attempt: 1 }),
    ev('quest.done', { questId: 'q1', hallId: 'h-herald', attempt: 1 }),
  ]
  const scene = deriveScene({ roster, quests, events, upTo: null })
  expect(scene.members.m2).toMatchObject({ status: 'idle', questId: null, bubble: null })
})

test('Bar the Gates closes the gate and lifting opens it', () => {
  seq = 0
  const barred = [ev('gates.barred', { barId: 'b', scope: 'guild', memberId: 'gm' })]
  expect(deriveScene({ roster, quests, events: barred, upTo: null }).gateClosed).toBe(true)
  const lifted = [...barred, ev('gates.lifted', { barId: 'b', scope: 'guild', memberId: 'gm' })]
  expect(deriveScene({ roster, quests, events: lifted, upTo: null }).gateClosed).toBe(false)
})

test('Treasury spend adds to the coin counter; revenue does not', () => {
  seq = 0
  const events = [
    ev('treasury.entry', { kind: 'revenue', bucket: 'operating', amountCents: 5000 }),
    ev('treasury.entry', { kind: 'spend_settle', bucket: 'operating', amountCents: -120 }),
    ev('treasury.entry', { kind: 'spend_settle', bucket: 'operating', amountCents: -30 }),
  ]
  expect(deriveScene({ roster, quests, events, upTo: null }).coinsCents).toBe(150)
})

test('replay: upTo folds only events up to that seq', () => {
  seq = 0
  const events = [
    ev('quest.claimed', { questId: 'q1', hallId: 'h-herald', attempt: 1 }),
    ev('gates.barred', { barId: 'b', scope: 'guild', memberId: 'gm' }),
  ]
  const early = deriveScene({ roster, quests, events, upTo: 1 })
  expect(early.gateClosed).toBe(false)
  expect(early.members.m2?.status).toBe('working')
  expect(early.appliedSeq).toBe(1)
})

test('a paused Hall shows paused; malformed payloads are ignored', () => {
  seq = 0
  const events = [
    ev('hall.paused', { hallId: 'h-herald', tripwire: 't' }),
    ev('quest.claimed', 'nonsense'),
  ]
  const scene = deriveScene({ roster, quests, events, upTo: null })
  expect(scene.rooms[0]?.paused).toBe(true)
  expect(scene.members.m2?.status).toBe('idle')
})
