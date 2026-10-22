import { expect, test } from 'bun:test'
import { wantsApply } from './orphan-guilds'

test('removal needs --apply; anything else is a dry run', () => {
  expect(wantsApply(['bun', 'orphan-guilds.ts'])).toBe(false)
  expect(wantsApply(['bun', 'orphan-guilds.ts', '--dry-run'])).toBe(false)
  expect(wantsApply(['bun', 'orphan-guilds.ts', '--apply'])).toBe(true)
})
