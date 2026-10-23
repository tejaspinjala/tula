import { expect, test } from 'bun:test'
import { MemoryNoteStore } from '../apps/guildd/src/adapters/memory-note-store'
import { rekeyGuilds, wantsApply } from './rekey-note-links'

test('rewriting needs --apply; anything else is a dry run', () => {
  expect(wantsApply(['bun', 'rekey-note-links.ts'])).toBe(false)
  expect(wantsApply(['bun', 'rekey-note-links.ts', '--apply'])).toBe(true)
})

test('rekeyGuilds reports only guilds with changes', async () => {
  const notes = new MemoryNoteStore()
  expect((await rekeyGuilds(notes, ['a', 'b'], false)).size).toBe(0)
})
