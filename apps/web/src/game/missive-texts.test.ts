import { expect, test } from 'bun:test'
import type { ReplayEvent } from '../replay'
import { hallsToFetch, mergeTexts } from './missive-texts'

function sent(seq: number, missiveId: string, hall: string): ReplayEvent {
  return {
    seq,
    type: 'missive.sent',
    payload: { missiveId, from: 'm1', to: 'hall', hall },
    occurredAt: 'x',
  }
}

test('only Halls with a Missive whose text is not yet known are fetched, once each', () => {
  const events = [
    sent(1, 'a', 'h1'),
    sent(2, 'b', 'h1'),
    sent(3, 'c', 'h2'),
    { seq: 4, type: 'quest.done', payload: { questId: 'q' }, occurredAt: 'x' },
  ]
  expect(hallsToFetch(events, { c: 'known' })).toEqual(['h1'])
  expect(hallsToFetch(events, {})).toEqual(['h1', 'h2'])
  expect(hallsToFetch(events, { a: '1', b: '2', c: '3' })).toEqual([])
})

test('a fetched page adds its texts to the known ones without dropping earlier ones', () => {
  const merged = mergeTexts({ a: 'one' }, [
    { id: 'b', from: 'm1', to: 'hall', text: 'two', sentAt: 'x' },
  ])
  expect(merged).toEqual({ a: 'one', b: 'two' })
})
