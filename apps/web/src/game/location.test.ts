import { describe, expect, test } from 'bun:test'
import {
  announceLocation,
  fadeInAlphas,
  fadeOutAlphas,
  type LocationStore,
  locationKey,
  locationName,
  parseLocation,
  rememberLocation,
  restoreLocation,
  signLines,
} from './location'
import type { MapKey } from './world'

const everything = () => true

describe('the doorway fade', () => {
  test('goes to black in four stepped frames and back in four', () => {
    expect(fadeOutAlphas(false)).toEqual([0.25, 0.5, 0.75, 1])
    expect(fadeInAlphas(false)).toEqual([0.75, 0.5, 0.25, 0])
  })

  test('reduced motion has zero frames: the cut is instant', () => {
    expect(fadeOutAlphas(true)).toEqual([])
    expect(fadeInAlphas(true)).toEqual([])
  })
})

describe('the last room kept in browser storage', () => {
  const memory = (initial: Record<string, string> = {}): LocationStore => {
    const data: Record<string, string> = { ...initial }
    return {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value
      },
    }
  }
  const guild = 'g-1'

  test('is kept per guild', () => {
    expect(locationKey('a')).not.toBe(locationKey('b'))
    const store = memory()
    rememberLocation(store, 'a', 'plaza')
    rememberLocation(store, 'b', 'hall:h1')
    expect(restoreLocation(store, 'a', everything)).toBe('plaza')
    expect(restoreLocation(store, 'b', everything)).toBe('hall:h1')
  })

  test('falls back to the Great Hall when storage is unavailable', () => {
    const throwing: LocationStore = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(restoreLocation(throwing, guild, everything)).toBe('hall')
    expect(restoreLocation(null, guild, everything)).toBe('hall')
    expect(restoreLocation(undefined, guild, everything)).toBe('hall')
    expect(() => rememberLocation(throwing, guild, 'plaza')).not.toThrow()
    expect(() => rememberLocation(null, guild, 'plaza')).not.toThrow()
  })

  test('falls back to the Great Hall for nothing saved, junk, or a room that is gone', () => {
    expect(restoreLocation(memory(), guild, everything)).toBe('hall')
    expect(restoreLocation(memory({ [locationKey(guild)]: 'nowhere' }), guild, everything)).toBe(
      'hall'
    )
    const gone = memory({ [locationKey(guild)]: 'hall:removed' })
    expect(restoreLocation(gone, guild, (key: MapKey) => key !== 'hall:removed')).toBe('hall')
  })

  test('maps the renamed vault id to the Counting House', () => {
    expect(parseLocation('vault')).toBe('counting-house')
    expect(parseLocation('archive')).toBe('archive')
    expect(parseLocation('hall:abc')).toBe('hall:abc')
    expect(parseLocation('hall:')).toBeNull()
    expect(parseLocation(null)).toBeNull()
  })
})

describe('room names for the live region', () => {
  const halls: Record<string, string> = { h1: 'Research' }
  const name = (key: MapKey) => locationName(key, (id) => halls[id])

  test('names the Great Hall, the town maps and each Hall', () => {
    expect(name('hall')).toBe('Great Hall')
    expect(name('plaza')).toBe('Plaza')
    expect(name('archive')).toBe('Archive')
    expect(name('counting-house')).toBe('Counting House')
    expect(name('trail')).toBe('Trail')
    expect(name('hall:h1')).toBe('Research Hall')
    expect(name('hall:ghost')).toBe('empty room')
  })

  test('is said as a sentence', () => {
    expect(announceLocation('Great Hall')).toBe('You are in the Great Hall.')
    expect(announceLocation('Research Hall')).toBe('You are in the Research Hall.')
    expect(announceLocation('empty room')).toBe('You are in an empty room.')
  })
})

describe('doorway signs show the whole Hall name', () => {
  const plain = (lines: string[]) => lines.join('').replaceAll('-', '')

  test('a short name is one line', () => {
    expect(signLines('Persona')).toEqual(['Persona'])
  })

  test('words wrap onto lines', () => {
    expect(signLines('Research Hall')).toEqual(['Research', 'Hall'])
  })

  test('a long word is split with a hyphen, never cut off', () => {
    const lines = signLines('Relationships')
    expect(lines.length).toBeGreaterThan(1)
    expect(plain(lines)).toBe('Relationships')
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(10)
    }
  })

  test('an absurd name is cut with a tilde on the last line, like a bubble', () => {
    const lines = signLines('Wonderfully Extraordinarily Longwinded Appellation Hall')
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines.at(-1)?.endsWith('~')).toBe(true)
  })
})
