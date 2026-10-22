import { expect, test } from 'bun:test'
import { formatGameTime } from './game-time'

const at = new Date(2026, 0, 1, 9, 5)

test('a time today reads as local hours and minutes', () => {
  expect(formatGameTime(at.toISOString(), new Date(2026, 0, 1, 20, 0))).toBe('09:05')
})

test('a time on another day adds the local date', () => {
  expect(formatGameTime(at.toISOString(), new Date(2026, 0, 2, 8, 0))).toBe('2026-01-01 09:05')
})

test('an unreadable timestamp is shown as given', () => {
  expect(formatGameTime('soon', new Date(2026, 0, 2))).toBe('soon')
})
