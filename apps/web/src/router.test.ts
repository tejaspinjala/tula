import { expect, test } from 'bun:test'
import { BAG_PAGES, isKnownPath, pageFor } from './router'

test('the Bag lists every page in menu order, ending with Settings', () => {
  expect(BAG_PAGES.map((p) => p.label)).toEqual([
    'Guild Map',
    'Quest Board',
    'Seals',
    'Treasury',
    'Ledger of Deeds',
    'Guild builder',
    'Rites',
    'Charter',
    'Missives',
    'Mailbox',
    'Council',
    'Gates',
    'Settings',
  ])
})

test('the world path opens no page', () => {
  expect(pageFor('/', '')).toBeNull()
  expect(pageFor('/hall', '')).toBeNull()
})

test('a page path opens its page, with or without a trailing slash', () => {
  expect(pageFor('/quests', '')).toBe('quests')
  expect(pageFor('/treasury/', '')).toBe('treasury')
  expect(pageFor('/gates', '')).toBe('gates')
})

test('the old ledger paths open the page that now holds them', () => {
  expect(pageFor('/archive', '')).toBe('ledger')
  expect(pageFor('/timeline', '')).toBe('ledger')
  expect(pageFor('/roster', '')).toBe('guild')
  expect(pageFor('/vault', '')).toBe('settings')
})

test('a Seal deep link opens the Seals page, a path wins over it', () => {
  expect(pageFor('/', '?seal=abc')).toBe('seals')
  expect(pageFor('/quests', '?seal=abc')).toBe('quests')
})

test('unknown paths are not known', () => {
  expect(isKnownPath('/no-such')).toBe(false)
  expect(isKnownPath('/')).toBe(true)
  expect(isKnownPath('/vault')).toBe(true)
})

test('the Council page opens at /council', () => {
  expect(pageFor('/council', '')).toBe('council')
})

test('the Guild Map, Rites, Guild builder, Ledger of Deeds are workbench pages; the rest are menu pages', () => {
  const workbench = BAG_PAGES.filter((p) => p.size === 'workbench').map((p) => p.label)
  expect(workbench).toEqual(['Guild Map', 'Ledger of Deeds', 'Guild builder', 'Rites'])
  expect(BAG_PAGES.filter((p) => p.size === 'menu')).toHaveLength(BAG_PAGES.length - 4)
})
