import { describe, expect, test } from 'bun:test'
import { parseWikiLinks, wikiLinks } from './note-store'

describe('wikiLinks', () => {
  test('returns bare target keys for alias, heading and block forms', () => {
    expect(wikiLinks('[[A|x]] [[B#h]] [[C#^b1|y]] [[D]]')).toEqual(['a', 'b', 'c', 'd'])
  })
  test('finds titles containing brackets', () => {
    expect(wikiLinks('[[Knee [left] pain]] and [[Market [stalls] "list"]]')).toEqual([
      'knee [left] pain',
      'market [stalls] "list"',
    ])
  })
  test('reads the innermost link when [[ is nested', () => {
    expect(wikiLinks('[[ [[T]]')).toEqual(['t'])
    expect(wikiLinks('[[a [[T]] b]]')).toEqual(['t'])
    expect(wikiLinks('[[[[T]]]]')).toEqual(['t'])
  })
  test('de-duplicates and skips empty links', () => {
    expect(wikiLinks('[[A]] [[a|z]] [[]] [[ ]] [[|x]]')).toEqual(['a'])
  })
})

describe('parseWikiLinks', () => {
  test('splits target, heading and alias with source offsets', () => {
    expect(parseWikiLinks('x [[T#H|al]] y')).toEqual([
      { start: 2, end: 12, target: 'T', heading: 'H', alias: 'al' },
    ])
  })
})
