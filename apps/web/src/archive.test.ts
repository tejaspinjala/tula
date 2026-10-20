import { expect, test } from 'bun:test'
import { addNote, listNotes, readNote, searchNotes } from './archive'
import { PasskeyRequestError } from './passkeys'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const note = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'text',
  version: 1,
  title: 'Runbook',
  body: 'steps',
  trust: 'quarantined',
  evidence: null,
}

function fakes(replies: Record<string, { status?: number; body: unknown }>) {
  const seen: Array<{ url: string; method: string; auth: string | null; body: unknown }> = []
  const fetcher = async (url: string, init?: RequestInit) => {
    seen.push({
      url,
      method: init?.method ?? 'GET',
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    const reply = replies[url] ?? { body: {} }
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }
  return { fetcher, seen }
}

test('adding a note posts it with the session token and returns the stored note', async () => {
  const { fetcher, seen } = fakes({
    [`/api/guilds/${guild}/archive/notes`]: { status: 201, body: note },
  })
  const added = await addNote(
    session,
    { kind: 'text', title: 'Runbook', body: 'steps', claim: 'assumption' },
    fetcher
  )
  expect(added.trust).toBe('quarantined')
  expect(seen[0]?.method).toBe('POST')
  expect(seen[0]?.auth).toBe('Bearer t1')
})

test('a fact without evidence surfaces the server refusal code', async () => {
  const { fetcher } = fakes({
    [`/api/guilds/${guild}/archive/notes`]: { status: 422, body: { error: 'evidence_required' } },
  })
  const failure = await addNote(
    session,
    { kind: 'text', title: 'T', body: 'b', claim: 'fact' },
    fetcher
  ).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(PasskeyRequestError)
  expect(failure instanceof PasskeyRequestError && failure.code).toBe('evidence_required')
})

test('list, search and read go to the guild archive routes', async () => {
  const page = { notes: [note], next: null }
  const detail = { note, versions: [note], backlinks: [{ id: note.id, title: 'Retro' }] }
  const { fetcher, seen } = fakes({
    [`/api/guilds/${guild}/archive/notes?limit=50`]: { body: page },
    [`/api/guilds/${guild}/archive/notes?limit=50&q=run%20book`]: { body: page },
    [`/api/guilds/${guild}/archive/notes/${note.id}`]: { body: detail },
  })
  expect((await listNotes(session, fetcher)).notes).toHaveLength(1)
  expect((await searchNotes(session, 'run book', fetcher)).notes).toHaveLength(1)
  expect((await readNote(session, note.id, fetcher)).backlinks[0]?.title).toBe('Retro')
  expect(seen).toHaveLength(3)
})
