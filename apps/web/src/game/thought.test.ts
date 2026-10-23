import { describe, expect, test } from 'bun:test'
import { THOUGHT_CHARS, thoughtText } from './thought'

const working = { status: 'working', questTitle: 'Draft the launch note' } as const

describe('thoughtText', () => {
  test('a Member working at their station keeps the Quest title, cut with a tilde', () => {
    const text = thoughtText(working, 'station', false)
    expect(text).toBe('Draft the launch~')
    expect(text?.length).toBe(THOUGHT_CHARS)
  })

  test('a short title is shown whole', () => {
    expect(thoughtText({ status: 'working', questTitle: 'Fix bug' }, 'station', false)).toBe(
      'Fix bug'
    )
  })

  test('no bubble when idle, without a title, on the move, or while a speech bubble is up', () => {
    expect(thoughtText({ status: 'idle', questTitle: 'Old' }, 'station', false)).toBeNull()
    expect(thoughtText({ status: 'working' }, 'station', false)).toBeNull()
    expect(thoughtText({ status: 'working', questTitle: '   ' }, 'station', false)).toBeNull()
    expect(thoughtText(working, 'moving', false)).toBeNull()
    expect(thoughtText(working, 'station', true)).toBeNull()
  })
})
