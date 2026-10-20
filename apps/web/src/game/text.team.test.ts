import { expect, test } from 'bun:test'
import type { ReplayEvent } from '../replay'
import { deriveScene, type SceneQuest, type SceneRoster } from './scene'
import { sceneSummary } from './text'

const roster: SceneRoster = {
  steward: { id: 's1', name: 'Steward' },
  halls: [
    {
      id: 'h',
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
  { id: 'q1', title: 'Write the notice', hallId: 'h', ownerId: 'm2' },
  { id: 'q2', title: 'Draft the headline', hallId: 'h', ownerId: 'm2' },
]
let seq = 0
function ev(type: string, payload: unknown): ReplayEvent {
  seq += 1
  return { seq, type, payload, occurredAt: '2026-10-20T10:00:00Z' }
}

test('the live region tells the team activity: Campaign, board, apprentices and a missive', () => {
  seq = 0
  const events = [
    ev('campaign.started', { campaignId: 'c1' }),
    ev('quest.posted', { questId: 'q1', hallId: 'h', attempt: 0 }),
    ev('quest.claimed', { questId: 'q1', memberId: 'm2', hall: 'h', hallId: 'h' }),
    ev('quest.spawned', { parentId: 'q1', childId: 'q2', depth: 1 }),
    ev('missive.sent', { missiveId: 'x1', from: 'm1', to: 'm2', hall: 'h' }),
  ]
  const scene = deriveScene({
    roster,
    quests,
    events,
    upTo: null,
    missiveTexts: { x1: 'Mind the headline' },
  })
  const summary = sceneSummary(scene)
  expect(summary).toContain('A team Campaign is running.')
  expect(summary).toContain('Heralds: 1 Quest on the Quest Board.')
  expect(summary).toContain('Heralds: 1 apprentice, Draft the headline.')
  expect(summary).toContain('Ada says: Mind the headline.')
})

test('with no team activity the summary says none of it', () => {
  const scene = deriveScene({ roster, quests, events: [], upTo: null })
  expect(sceneSummary(scene)).not.toMatch(/Campaign|apprentice|Quest Board|says/)
})
