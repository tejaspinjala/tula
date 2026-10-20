import { describe, expect, test } from 'bun:test'
import { safeEqual } from './constant-time'

describe('safeEqual', () => {
  test('equal strings match, different ones do not', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true)
    expect(safeEqual('abc123', 'abc124')).toBe(false)
  })

  test('a length mismatch is false rather than a throw', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'a')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })

  test('multi-byte characters compare by bytes', () => {
    expect(safeEqual('é', 'é')).toBe(true)
    expect(safeEqual('é', 'e')).toBe(false)
  })
})
