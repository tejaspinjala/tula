import { expect, test } from 'bun:test'
import { reconnectDelayMs, streamNotice } from './stream-retry'

test('the reconnect delay doubles from half a second, jittered between half and all of the ceiling, capped at 30s', () => {
  expect(reconnectDelayMs(0, 0)).toBe(250)
  expect(reconnectDelayMs(0, 1)).toBe(500)
  expect(reconnectDelayMs(2, 0)).toBe(1000)
  expect(reconnectDelayMs(2, 1)).toBe(2000)
  expect(reconnectDelayMs(20, 1)).toBe(30_000)
  expect(reconnectDelayMs(20, 0)).toBe(15_000)
})

test('the Hall says so in-world only after several failed attempts in a row', () => {
  expect(streamNotice(0)).toBeNull()
  expect(streamNotice(2)).toBeNull()
  expect(streamNotice(3)).toContain('messenger')
  expect(streamNotice(9)).toContain('messenger')
})
