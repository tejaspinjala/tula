import { expect, test } from 'bun:test'
import { type ReplayEvent, replayTo } from './replay'

const ev = (seq: number, at: string, type: string, payload: unknown): ReplayEvent => ({
  seq,
  type,
  payload,
  occurredAt: `2026-03-01T${at}.000Z`,
})

const log: ReplayEvent[] = [
  ev(1, '08:00:00', 'guild.founded', { name: 'Ember', goal: 'Ship' }),
  ev(2, '08:01:00', 'treasury.entry', { entryId: 'e1', bucket: 'operating', amountCents: 5000 }),
  ev(3, '08:01:00', 'treasury.entry', { entryId: 'e2', bucket: 'reserve', amountCents: 2000 }),
  ev(4, '09:00:00', 'quest.posted', { questId: 'q1', hallId: 'h1', attempt: 0 }),
  ev(5, '09:05:00', 'quest.claimed', { questId: 'q1', hallId: 'h1', attempt: 1 }),
  ev(6, '09:10:00', 'quest.posted', { questId: 'q2', hallId: 'h1', attempt: 0 }),
  ev(7, '09:20:00', 'quest.awaiting_seal', { questId: 'q1', hallId: 'h1', attempt: 1 }),
  ev(8, '09:20:00', 'seal.requested', { sealId: 's1', questId: 'q1', actionHash: 'h' }),
  ev(9, '10:00:00', 'hall.paused', { pauseId: 'p1', hallId: 'h1', tripwire: 'spend' }),
  ev(10, '10:30:00', 'note.added', { noteId: 'n1', version: 1, kind: 'lesson' }),
  ev(11, '10:31:00', 'note.edited', { noteId: 'n1', version: 2, kind: 'lesson' }),
  ev(12, '11:00:00', 'seal.approved', { sealId: 's1', questId: 'q1', actionHash: 'h' }),
  ev(13, '11:01:00', 'treasury.entry', { entryId: 'e3', bucket: 'operating', amountCents: -1200 }),
  ev(14, '11:30:00', 'hall.resumed', { pauseId: 'p1', hallId: 'h1' }),
  ev(15, '12:00:00', 'quest.done', { questId: 'q1', hallId: 'h1', attempt: 1 }),
  ev(16, '12:01:00', 'seal.consumed', { sealId: 's1', questId: 'q1', actionHash: 'h' }),
  ev(17, '12:30:00', 'note.added', { noteId: 'n2', version: 1, kind: 'lesson' }),
]

test('replaying to a seq rebuilds Quests, Seals, pauses, balances and notes at that point', () => {
  const state = replayTo(log, { seq: 10 })
  expect(state.quests).toEqual({
    queued: ['q2'],
    active: [],
    awaiting_seal: ['q1'],
    done: [],
    dead: [],
  })
  expect(state.seals.requested).toEqual(['s1'])
  expect(state.pausedHalls).toEqual(['h1'])
  expect(state.balances).toEqual({ operating: 5000, reserve: 2000, profit: 0 })
  expect(state.notes).toBe(1)
  expect(state.appliedSeq).toBe(10)
})

test('replaying to the end shows the latest state', () => {
  const state = replayTo(log, null)
  expect(state.quests.done).toEqual(['q1'])
  expect(state.quests.queued).toEqual(['q2'])
  expect(state.seals.consumed).toEqual(['s1'])
  expect(state.seals.requested).toEqual([])
  expect(state.pausedHalls).toEqual([])
  expect(state.balances.operating).toBe(3800)
  expect(state.notes).toBe(2)
})

test('replaying to a time includes every event at or before that instant, and no later one', () => {
  const state = replayTo(log, { time: '2026-03-01T11:00:00.000Z' })
  expect(state.appliedSeq).toBe(12)
  expect(state.seals.approved).toEqual(['s1'])
  expect(state.balances.operating).toBe(5000)
  expect(replayTo(log, { time: '2026-03-01T07:59:59.999Z' }).appliedSeq).toBe(0)
})

test('the same events give the same state, whatever order they arrive in', () => {
  const shuffled = [...log].reverse()
  expect(replayTo(shuffled, { seq: 14 })).toEqual(replayTo(log, { seq: 14 }))
})

test('unknown events and malformed payloads leave the state unchanged', () => {
  const noisy = [ev(1, '08:00:00', 'quest.posted', { nope: true }), ev(2, '08:00:01', 'x.y', 5)]
  const state = replayTo(noisy, null)
  expect(state.quests.queued).toEqual([])
  expect(state.appliedSeq).toBe(2)
})

test('a Council-approved Seal is its own status in the ledger and never counts as approved or posted', () => {
  const state = replayTo(
    [
      ev(1, '10:00:00', 'seal.requested', { sealId: 's9', questId: 'q9', actionHash: 'h' }),
      ev(2, '10:01:00', 'seal.council_approved', {
        sealId: 's9',
        questId: 'q9',
        actionHash: 'h',
        sessionId: 'c1',
      }),
    ],
    null
  )
  expect(state.seals.council_approved).toEqual(['s9'])
  expect(state.seals.approved).toEqual([])
  expect(state.seals.consumed).toEqual([])
})
