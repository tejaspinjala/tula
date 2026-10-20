import { expect, test } from 'bun:test'
import { deriveScene } from './scene'
import { readEventFrame, sceneSummary } from './text'

test('readEventFrame reads an event frame and ignores snapshots and junk', () => {
  const frame = JSON.stringify({
    type: 'event',
    event: {
      seq: 7,
      type: 'quest.claimed',
      payload: { questId: 'q' },
      occurredAt: '2026-10-20T10:00:00Z',
    },
  })
  expect(readEventFrame(frame)).toEqual({
    seq: 7,
    type: 'quest.claimed',
    payload: { questId: 'q' },
    occurredAt: '2026-10-20T10:00:00Z',
  })
  expect(readEventFrame(JSON.stringify({ type: 'snapshot', head: 3 }))).toBeNull()
  expect(readEventFrame('not json')).toBeNull()
  expect(readEventFrame(JSON.stringify({ type: 'event', event: { seq: 'x' } }))).toBeNull()
})

test('sceneSummary says what the canvas shows, for a screen reader', () => {
  const scene = deriveScene({
    roster: {
      steward: { id: 's', name: 'Steward' },
      halls: [
        {
          id: 'h1',
          name: 'Heralds',
          kind: 'work',
          locked: false,
          captain: null,
          members: [{ id: 'm', name: 'Bram', rank: 'member' }],
        },
        { id: 'h2', name: 'Vault', kind: 'private', locked: true, captain: null, members: [] },
      ],
    },
    quests: [{ id: 'q', title: 'Write notice', hallId: 'h1', ownerId: 'm' }],
    events: [
      { seq: 1, type: 'quest.claimed', payload: { questId: 'q', hallId: 'h1' }, occurredAt: 'x' },
      { seq: 2, type: 'gates.barred', payload: { barId: 'b' }, occurredAt: 'x' },
    ],
    upTo: null,
  })
  expect(sceneSummary(scene)).toBe(
    'Guild hall. The gates are barred. Heralds: Bram is working on Write notice. Vault is locked. No Quests await a Seal. Treasury spend: $0.00.'
  )
})
