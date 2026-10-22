import { expect, test } from 'bun:test'
import { loadRoster } from './roster'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const steward = { id: 'steward', name: 'Steward' }
const hall = (id: string, locked = false) => ({
  id,
  name: id,
  kind: locked ? 'private' : 'work',
  locked,
  privateEligible: false,
  captain: locked ? null : { id: `${id}-c`, name: 'Captain' },
  members: locked ? [] : [{ id: `${id}-m`, name: 'Member', rank: 'apprentice' }],
})

test('the roster follows page cursors and collects the Steward and every Hall', async () => {
  const urls: string[] = []
  const pages: Record<string, unknown> = {
    [`/api/guilds/${guild}/roster?limit=2`]: { steward, halls: [hall('a'), hall('b')], next: 'b' },
    [`/api/guilds/${guild}/roster?limit=2&after=b`]: {
      steward,
      halls: [hall('c', true)],
      next: null,
    },
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    urls.push(`${url}|${new Headers(init?.headers).get('authorization')}`)
    return Response.json(pages[url] ?? {}, { status: pages[url] ? 200 : 404 })
  }
  const roster = await loadRoster(session, fetcher, 2)
  expect(roster.steward.name).toBe('Steward')
  expect(roster.halls.map((h) => h.id)).toEqual(['a', 'b', 'c'])
  expect(roster.halls[2]?.locked).toBe(true)
  expect(urls[0]?.endsWith('|Bearer t1')).toBe(true)
})

test('a refused roster request throws', async () => {
  const fetcher = async () => Response.json({ error: 'unauthenticated' }, { status: 401 })
  await expect(loadRoster(session, fetcher)).rejects.toThrow()
})

test('a Hall roomStyle survives the roster load and an unknown style is refused', async () => {
  const page = (style: string) => ({
    steward,
    halls: [{ ...hall('a'), roomStyle: style }],
    next: null,
  })
  const ok = await loadRoster(session, async () => Response.json(page('library')))
  expect(ok.halls[0]?.roomStyle).toBe('library')
  await expect(loadRoster(session, async () => Response.json(page('dungeon')))).rejects.toThrow()
})
