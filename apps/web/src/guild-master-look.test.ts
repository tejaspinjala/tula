import { expect, test } from 'bun:test'
import { loadGuildMasterLook, saveGuildMasterLook } from './guild-master-look'
import { loadRoster } from './roster'

const session = { token: 't1', guildId: '11111111-1111-4111-8111-111111111111' }
const look = { body: 2, outfitStyle: 4, outfitColor: 1, hairStyle: 0, hairColor: 7 }
const path = `/api/guilds/${session.guildId}/guild-master/look`

test('the saved look is read from the server with the session token', async () => {
  const seen: Array<{ url: string; auth: string | null }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
    return Response.json({ look })
  }
  expect(await loadGuildMasterLook(session, fetcher)).toEqual(look)
  expect(seen).toEqual([{ url: path, auth: 'Bearer t1' }])
})

test('no saved look reads as null, and a refused read rejects', async () => {
  expect(await loadGuildMasterLook(session, async () => Response.json({ look: null }))).toBeNull()
  await expect(
    loadGuildMasterLook(session, async () =>
      Response.json({ error: 'unauthenticated' }, { status: 401 })
    )
  ).rejects.toThrow()
})

test('saving PUTs the look and returns what the server stored', async () => {
  let sent: { method?: string | undefined; body?: unknown; auth: string | null } = { auth: null }
  const fetcher = async (_url: string, init?: RequestInit) => {
    sent = {
      method: init?.method,
      body: JSON.parse(String(init?.body)),
      auth: new Headers(init?.headers).get('authorization'),
    }
    return Response.json({ look })
  }
  expect(await saveGuildMasterLook(session, fetcher, look)).toEqual(look)
  expect(sent).toEqual({ method: 'PUT', body: { look }, auth: 'Bearer t1' })
})

test('a refused save rejects', async () => {
  await expect(
    saveGuildMasterLook(
      session,
      async () => Response.json({ error: 'invalid_look' }, { status: 400 }),
      look
    )
  ).rejects.toThrow()
})

test('the roster keeps a Member look override', async () => {
  const roster = await loadRoster(session, async () =>
    Response.json({
      steward: { id: 's', name: 'S' },
      halls: [
        {
          id: 'h',
          name: 'H',
          kind: 'work',
          locked: false,
          captain: null,
          members: [{ id: 'm', name: 'M', rank: 'adept', look }],
        },
      ],
      next: null,
    })
  )
  expect(roster.halls[0]?.members[0]).toMatchObject({ look })
})
