import { expect, test } from 'bun:test'
import { addNote, exportArchive, listNotes, readNote, searchNotes } from './archive'
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

const exportUrl = `/api/guilds/${guild}/archive/export`
const seenExport: Array<{ url: string; headers: Headers }> = []
const zipReply = (counts: unknown) => (url: string, init?: RequestInit) => {
  seenExport.push({ url, headers: new Headers(init?.headers) })
  return Promise.resolve(
    new Response('zipbytes', {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="Iron Guild-archive.zip"',
        'x-archive-counts': JSON.stringify(counts),
      },
    })
  )
}
const noBrowser = {
  get: async (): Promise<unknown> => {
    throw new Error('no passkey expected')
  },
  create: async (): Promise<unknown> => {
    throw new Error('no passkey expected')
  },
}

test('a public export returns the zip, its file name and counts without a re-auth proof', async () => {
  seenExport.length = 0
  const counts = { exported: 3, privateIncluded: 0, privateLeftOut: 2 }
  const out = await exportArchive(session, false, zipReply(counts), noBrowser)
  expect(seenExport[0]?.url).toBe(exportUrl)
  expect(seenExport[0]?.headers.get('authorization')).toBe('Bearer t1')
  expect(seenExport[0]?.headers.get('x-reauth-proof')).toBeNull()
  expect(out.filename).toBe('Iron Guild-archive.zip')
  expect(out.counts).toEqual(counts)
  expect(await out.blob.text()).toBe('zipbytes')
})

test('a private export runs the passkey re-auth and sends the proof', async () => {
  seenExport.length = 0
  const counts = { exported: 5, privateIncluded: 2, privateLeftOut: 0 }
  const fetcher = async (url: string, init?: RequestInit) => {
    if (url.endsWith('/session/reauth/begin')) {
      return Response.json({ challengeId: 'c1', options: { challenge: 'x' } })
    }
    if (url.endsWith('/session/reauth/finish')) {
      return Response.json({ proof: 'proof-1' })
    }
    return zipReply(counts)(url, init)
  }
  const browser = { ...noBrowser, get: async (): Promise<unknown> => ({ id: 'cred' }) }
  const out = await exportArchive(session, true, fetcher, browser)
  expect(seenExport[0]?.url).toBe(`${exportUrl}?private=true`)
  expect(seenExport[0]?.headers.get('x-reauth-proof')).toBe('proof-1')
  expect(out.counts.privateIncluded).toBe(2)
})

test('401, 403 and 413 surface their status and code', async () => {
  for (const [status, error] of [
    [401, 'unauthorized'],
    [403, 'reauth_required'],
    [413, 'archive_too_large'],
  ] as const) {
    const failure = await exportArchive(
      session,
      false,
      async () => Response.json({ error }, { status }),
      noBrowser
    ).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(PasskeyRequestError)
    expect(failure instanceof PasskeyRequestError && [failure.status, failure.code]).toEqual([
      status,
      error,
    ])
  }
})
