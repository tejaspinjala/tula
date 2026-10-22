import { expect, test } from 'bun:test'
import { sampleCharter } from './fixtures'
import { CharterFileError, parseCharter } from './schema'

test('a valid Charter file parses', () => {
  expect(parseCharter(JSON.stringify(sampleCharter)).name).toBe('Heralds Guild')
})

test('a file that is not JSON is refused with a reason', () => {
  expect(() => parseCharter('{nope')).toThrow(CharterFileError)
})

test('a document of another shape is refused', () => {
  expect(() => parseCharter(JSON.stringify({ charter: 2 }))).toThrow(CharterFileError)
  expect(() => parseCharter(JSON.stringify({ ...sampleCharter, rites: 'x' }))).toThrow(
    CharterFileError
  )
})

test('a file over 256 KB is refused before parsing', () => {
  expect(() => parseCharter(' '.repeat(256 * 1024 + 1))).toThrow(/too large/)
})
