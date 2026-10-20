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
      captain: null,
      members: [
        { id: 'm1', name: 'Ada', rank: 'captain' },
        { id: 'm2', name: 'Bram', rank: 'member' },
      ],
    },
  ],
}
const quests: SceneQuest[] = [
  { id: 'q1', title: 'Write the herald notice', hallId: 'h-herald', ownerId: 'm2' },
  { id: 'q2', title: 'Draft the headline', hallId: 'h-herald', ownerId: 'm2' },
  { id: 'q3', title: 'Proof the headline', hallId: 'h-herald', ownerId: 'm1' },
]
let seq = 0
function ev(type: string, payload: unknown): ReplayEvent {
  seq += 1
  return { seq, type, payload, occurredAt: `2026-10-20T10:00:${String(seq).padStart(2, '0')}Z` }
}
const claim = (questId: string, memberId: string) =>
  ev('quest.claimed', { questId, memberId, hall: 'h-herald', hallId: 'h-herald', attempt: 1 })
function derive(
  events: ReplayEvent[],
  extra: { missiveTexts?: Record<string, string>; upTo?: number | null } = {}
) {
  return deriveScene({
    roster,
    quests,
    events,
    upTo: extra.upTo ?? null,
    missiveTexts: extra.missiveTexts,
  })
}

test('a claim records its seq so the Member walks to the Quest Board', () => {
  seq = 0
  const scene = derive([claim('q1', 'm2')])
  expect(scene.members.m2?.claimSeq).toBe(1)
  expect(scene.members.m1?.claimSeq).toBeNull()
})

test('a spawned Sub-Quest is an apprentice in the parent Hall until the child is done', () => {
  seq = 0
  const events = [
    claim('q1', 'm2'),
    ev('quest.spawned', { parentId: 'q1', childId: 'q2', depth: 1 }),
  ]
  expect(derive(events).apprentices).toEqual([
    { childId: 'q2', parentId: 'q1', hallId: 'h-herald', title: 'Draft the headline', seq: 2 },
  ])
  const left = derive([...events, ev('quest.done', { questId: 'q2', hallId: 'h-herald' })])
  expect(left.apprentices).toEqual([])
})

test('a dead child also sends its apprentice away; replay before the spawn has none', () => {
  seq = 0
  const events = [
    ev('quest.spawned', { parentId: 'q1', childId: 'q2', depth: 1 }),
    ev('quest.dead', { questId: 'q2', hallId: 'h-herald' }),
  ]
  expect(derive(events).apprentices).toEqual([])
  expect(derive(events, { upTo: 1 }).apprentices).toHaveLength(1)
  expect(derive(events, { upTo: 0 }).apprentices).toEqual([])
})

test('a missive gives its sender a bubble with the real text, none until the text is known', () => {
  seq = 0
  const events = [ev('missive.sent', { missiveId: 'x1', from: 'm1', to: 'm2', hall: 'h-herald' })]
  expect(derive(events).members.m1?.bubble).toBeNull()
  const told = derive(events, { missiveTexts: { x1: 'Take the headline, I have the notice.' } })
  expect(told.members.m1?.bubble).toEqual({ text: 'Take the headline, I have the notice.', seq: 1 })
  expect(told.members.m2?.bubble).toBeNull()
})

test('the newest of a claim and a missive is the bubble shown', () => {
  seq = 0
  const events = [
    ev('missive.sent', { missiveId: 'x1', from: 'm2', to: 'hall', hall: 'h-herald' }),
    claim('q1', 'm2'),
  ]
  const scene = derive(events, { missiveTexts: { x1: 'Starting now' } })
  expect(scene.members.m2?.bubble).toEqual({ text: 'Write the herald notice', seq: 2 })
  const later = ev('missive.sent', { missiveId: 'x2', from: 'm2', to: 'hall', hall: 'h-herald' })
  const after = derive([...events, later], {
    missiveTexts: { x1: 'Starting now', x2: 'Done soon' },
  })
  expect(after.members.m2?.bubble).toEqual({ text: 'Done soon', seq: 3 })
})

test('a team Campaign fills the board while Quests are posted and empties as they settle', () => {
  seq = 0
  const posted = [
    ev('campaign.started', { campaignId: 'c1' }),
    ev('quest.posted', { questId: 'q1', hallId: 'h-herald', attempt: 0 }),
    ev('quest.posted', { questId: 'q2', hallId: 'h-herald', attempt: 0 }),
  ]
  const full = derive(posted)
  expect(full.campaigns).toEqual(['c1'])
  expect(full.rooms[0]?.board).toBe(2)
  const settled = derive([
    ...posted,
    ev('quest.done', { questId: 'q1', hallId: 'h-herald' }),
    ev('quest.done', { questId: 'q2', hallId: 'h-herald' }),
    ev('campaign.finished', { campaignId: 'c1' }),
  ])
  expect(settled.campaigns).toEqual([])
  expect(settled.rooms[0]?.board).toBe(0)
})
