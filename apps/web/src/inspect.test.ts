import { expect, test } from 'bun:test'
import { activityFeed } from './inspect'

const at = '2026-01-01T00:00:00.000Z'
const act = (seq: number, memberId: string, activity: string, questId = 'q1') => ({
  seq,
  type: 'member.activity',
  payload: { questId, memberId, hallId: 'heralds', activity },
  occurredAt: at,
})

test('the feed lists only that Member’s activity, newest first, in words', () => {
  const events = [
    act(1, 'ana', 'reading_brief'),
    act(2, 'bo', 'writing'),
    act(3, 'ana', 'researching'),
    { seq: 4, type: 'quest.claimed', payload: {}, occurredAt: at },
  ]
  const feed = activityFeed(events, 'ana', 10)
  expect(feed.entries.map((e) => [e.seq, e.label])).toEqual([
    [3, 'Researching'],
    [1, 'Reading the brief'],
  ])
  expect(feed.more).toBe(false)
})

test('the feed is a page at a time and says when there is more', () => {
  const events = [1, 2, 3, 4, 5].map((n) => act(n, 'ana', 'thinking'))
  const feed = activityFeed(events, 'ana', 2)
  expect(feed.entries.map((e) => e.seq)).toEqual([5, 4])
  expect(feed.more).toBe(true)
})

test('an event with an odd payload is skipped, and no text is ever read from it', () => {
  const odd = {
    seq: 1,
    type: 'member.activity',
    payload: { memberId: 'ana', text: 'x' },
    occurredAt: at,
  }
  expect(activityFeed([odd], 'ana', 5).entries).toEqual([])
})
