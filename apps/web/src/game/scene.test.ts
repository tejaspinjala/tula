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
test('a Member look override in the roster reaches the scene; others carry none', () => {
  const look = { body: 1, outfitStyle: 2, outfitColor: 3, hairStyle: 1, hairColor: 4 }
  const hall = roster.halls[0]
  if (!hall) {
    throw new Error('no hall')
  }
  const dressed: SceneRoster = {
    ...roster,
    halls: [
      { ...hall, members: hall.members.map((m) => (m.id === 'm2' ? { ...m, look } : m)) },
      ...roster.halls.slice(1),
    ],
  }
  const scene = deriveScene({ roster: dressed, quests: [], events: [], upTo: null })
  expect(scene.members.m2?.look).toEqual(look)
  expect(scene.members.m1?.look).toBeUndefined()
})

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
    ev('treasury.entry', { kind: 'spend_reserve', bucket: 'operating', amountCents: -120 }),
    ev('treasury.entry', { kind: 'spend_reserve', bucket: 'operating', amountCents: -30 }),
  ]
  expect(deriveScene({ roster, quests, events, upTo: null }).coinsCents).toBe(150)
})

test('the coin counter is the net spend: reserves minus settle refunds and releases', () => {
  seq = 0
  const events = [
    ev('treasury.entry', { kind: 'spend_reserve', bucket: 'operating', amountCents: -10 }),
    ev('treasury.entry', { kind: 'spend_settle', bucket: 'operating', amountCents: 4 }),
    ev('treasury.entry', { kind: 'spend_reserve', bucket: 'operating', amountCents: -20 }),
    ev('treasury.entry', { kind: 'spend_release', bucket: 'operating', amountCents: 20 }),
  ]
  expect(deriveScene({ roster, quests, events, upTo: null }).coinsCents).toBe(6)
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

test("a Captain the roster lists apart from the Members is still in their Hall's room, first", () => {
  const apart: SceneRoster = {
    steward: { id: 's1', name: 'Steward' },
    halls: [
      {
        id: 'h',
        name: 'Heralds',
        kind: 'work',
        locked: false,
        captain: { id: 'cap', name: 'Herald Captain' },
        members: [{ id: 'm2', name: 'Bram', rank: 'member' }],
      },
    ],
  }
  const scene = deriveScene({ roster: apart, quests: [], events: [], upTo: null })
  expect(scene.rooms[0]?.memberIds).toEqual(['cap', 'm2'])
  expect(scene.members.cap).toMatchObject({ rank: 'captain', hallId: 'h', status: 'idle' })
})

test('only a recent Missive pops a bubble; one minutes old stays out of the bubble', () => {
  seq = 0
  const events = [ev('missive.sent', { missiveId: 'mv1', from: 'm2' })]
  const said = Date.parse(events[0]?.occurredAt ?? '')
  const missiveTexts = { mv1: 'The ledger is balanced.' }
  const fresh = deriveScene({ roster, quests, events, upTo: null, missiveTexts, now: said + 5_000 })
  expect(fresh.members.m2?.bubble?.text).toBe('The ledger is balanced.')
  const stale = deriveScene({
    roster,
    quests,
    events,
    upTo: null,
    missiveTexts,
    now: said + 300_000,
  })
  expect(stale.members.m2?.bubble).toBeNull()
  expect(stale.members.m2?.saying?.text).toBe('The ledger is balanced.')
})

test('a cross-Hall Missive bubble names the sending Hall; one inside a Hall does not', () => {
  seq = 0
  const events = [
    ev('missive.sent', {
      missiveId: 'mv1',
      from: 'm2',
      to: 'v1',
      hall: 'h-herald',
      toHall: 'h-vault',
    }),
  ]
  const missiveTexts = { mv1: 'Send the ledger.' }
  const scene = deriveScene({ roster, quests, events, upTo: null, missiveTexts })
  expect(scene.members.m2?.bubble?.text).toBe('To Vaultkeepers: Send the ledger.')
  const inside = [ev('missive.sent', { missiveId: 'mv1', from: 'm2', hall: 'h-herald' })]
  expect(
    deriveScene({ roster, quests, events: inside, upTo: null, missiveTexts }).members.m2?.bubble
      ?.text
  ).toBe('Send the ledger.')
})

test('every configured Hall gets a room and its idle Members, an unlocked private Hall and a new work Hall included', () => {
  const halls: SceneRoster['halls'] = [
    { id: 'health', name: 'Health', kind: 'private', locked: false, captain: null, members: [] },
    {
      id: 'scribes',
      name: 'Scribes Hall',
      kind: 'work',
      locked: false,
      captain: null,
      members: [{ id: 'sc1', name: 'Scribe', rank: 'member' }],
    },
  ]
  const scene = deriveScene({
    roster: { steward: { id: 's1', name: 'Steward' }, halls },
    quests: [],
    events: [],
    upTo: null,
  })
  expect(scene.rooms.map((r) => [r.hallId, r.name, r.locked])).toEqual([
    ['health', 'Health', false],
    ['scribes', 'Scribes Hall', false],
  ])
  expect(scene.members.sc1).toMatchObject({ hallId: 'scribes', status: 'idle' })
  expect(scene.rooms[1]?.memberIds).toEqual(['sc1'])
})
