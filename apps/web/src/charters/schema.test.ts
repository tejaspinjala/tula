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

test('a file over 256 KB is refused', () => {
  expect(() => parseCharter(' '.repeat(4 * 256 * 1024 + 1))).toThrow(/too large/)
  const big = { ...sampleCharter, name: 'x'.repeat(256 * 1024) }
  expect(() => parseCharter(JSON.stringify(big))).toThrow(/too large/)
})

test('a pretty-printed document whose compact form is under the cap parses', () => {
  const pad = (n: number) => ({ ...sampleCharter, name: 'x'.repeat(n) })
  const room = 256 * 1024 - JSON.stringify(pad(0)).length
  const doc = pad(room - 10)
  expect(JSON.stringify(doc).length).toBeLessThan(256 * 1024)
  const pretty = JSON.stringify(doc, null, 2)
  expect(pretty.length).toBeGreaterThan(256 * 1024)
  expect(parseCharter(pretty).name.length).toBe(room - 10)
})
