import { expect, test } from 'bun:test'
import { bannerFor } from './banners'

const event = (type: string) => ({ seq: 1, type, payload: {}, occurredAt: '2026-10-20T00:00:00Z' })

test('a Seal request earns a banner that says a Seal is waiting', () => {
  expect(bannerFor(event('seal.requested'))).toEqual({
    verb: 'New',
    noun: 'Seal waiting',
    danger: false,
  })
})

test('a stamped Seal and a finished Quest are good news', () => {
  expect(bannerFor(event('seal.approved'))).toEqual({
    verb: 'Stamped',
    noun: 'a Seal',
    danger: false,
  })
  expect(bannerFor(event('quest.done'))).toEqual({
    verb: 'Finished',
    noun: 'a Quest',
    danger: false,
  })
})

test('a dead-lettered Quest, a barred Gate and a reached cap are danger', () => {
  expect(bannerFor(event('quest.dead'))?.danger).toBe(true)
  expect(bannerFor(event('gates.barred'))).toEqual({
    verb: 'The Gates are',
    noun: 'barred',
    danger: true,
  })
  expect(bannerFor(event('steward.cap_reached'))?.danger).toBe(true)
})

test('lifting the Gates is good news', () => {
  expect(bannerFor(event('gates.lifted'))).toEqual({
    verb: 'The Gates are',
    noun: 'lifted',
    danger: false,
  })
})

test('chatter such as a Missive or a claim earns no banner', () => {
  expect(bannerFor(event('missive.sent'))).toBeNull()
  expect(bannerFor(event('quest.claimed'))).toBeNull()
  expect(bannerFor(event('something.unknown'))).toBeNull()
})
