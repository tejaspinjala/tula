import { afterAll, describe, expect, test } from 'bun:test'
import { strFromU8, unzipSync } from 'fflate'
import { Hono } from 'hono'
import postgres from 'postgres'
import { parse } from 'yaml'
import { z } from 'zod'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryNoteStore } from '../adapters/memory-note-store'
import { PgNoteStore } from '../adapters/pg-note-store'
import { createDb } from '../db/client'
import { appendEvent } from '../events'
import { MAX_NOTE_PAGE, type NoteStore } from '../ports/note-store'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { ARCHIVE_EVENT } from './events'
import { type ArchiveExportedFact, mountArchiveExportRoutes } from './routes'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
const PROOF = 'fresh-proof'
const SECRET_TITLE = 'Vault-door-combination'
const SECRET_BODY = 'seven-three-nine private body'
const HALL = 'heralds'
const counts = z.object({
  exported: z.number(),
  privateIncluded: z.number(),
  privateLeftOut: z.number(),
})

/** A guild on the chosen adapters with one public and one private note, the session guard stubbed. */
interface SetupOptions {
  caps?: { maxNotes: number; maxBytes: number }
  guildName?: string
  zip?: (files: Record<string, Uint8Array>) => Uint8Array
  /** Wraps the note store, e.g. to count list calls. */
  wrapNotes?: (store: NoteStore) => NoteStore
}

async function setup(kind: 'memory' | 'postgres', options: SetupOptions = {}) {
  const { caps, guildName = 'Acme Guild', zip, wrapNotes } = options
  const keys = new MemoryKeyProvider()
  const guild =
    kind === 'memory'
      ? crypto.randomUUID()
      : await foundTestGuild(db, { name: guildName, goal: 'g' }, keys)
  const config = new MemoryConfigStore(clock)
  await config.seed(guild)
  const notes: NoteStore = kind === 'memory' ? new MemoryNoteStore() : new PgNoteStore(db, keys)
  const fact = { kind: 'text', claim: 'fact', evidence: 'seen' } as const
  await notes.add(
    guild,
    { ...fact, title: 'Public one', body: `see [[${SECRET_TITLE}]] and [[Public one]]` },
    HALL
  )
  await notes.add(
    guild,
    { ...fact, title: SECRET_TITLE, body: SECRET_BODY },
    HALL,
    undefined,
    'private'
  )

  const memoryEvents: ArchiveExportedFact[] = []
  let proofsSpent = 0
  const app = new Hono()
  mountArchiveExportRoutes(app, {
    notes: wrapNotes === undefined ? notes : wrapNotes(notes),
    config,
    clock,
    guildName: async (id) => (id === guild ? guildName : null),
    checkSensitive: async (c) => {
      if (c.req.header('x-reauth-proof') !== PROOF) {
        return { ok: false, status: 403, error: 'reauth_required' }
      }
      proofsSpent++
      return {
        ok: true,
        guildId: guild,
        principal: { guildId: guild, memberId: 'm', role: 'guild_master' },
      }
    },
    recordExported: async (id, fact) => {
      if (kind === 'memory') {
        memoryEvents.push(fact)
        return
      }
      await db.withGuild(id, (tx) => appendEvent(tx, keys, ARCHIVE_EVENT.exported, fact))
    },
    guildMasterSessionFor: async (c) => ({ guild: c.req.param('id') ?? '' }),
    ...(caps === undefined ? {} : { caps }),
    ...(zip === undefined ? {} : { zip }),
  })
  const events = async (): Promise<unknown[]> => {
    if (kind === 'memory') {
      return memoryEvents
    }
    const rows =
      await owner`select payload from events where guild_id = ${guild} and type = ${ARCHIVE_EVENT.exported}`
    return rows.map((r) => r.payload)
  }
  const get = (query = '', headers: Record<string, string> = {}, id = guild) =>
    app.request(`/guilds/${id}/archive/export${query}`, { headers })
  return { guild, notes, get, events, proofsSpent: () => proofsSpent }
}

async function unzip(res: Response): Promise<{ bytes: Uint8Array; files: Record<string, string> }> {
  const bytes = new Uint8Array(await res.arrayBuffer())
  const files = Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([path, data]) => [path, strFromU8(data)])
  )
  return { bytes, files }
}

for (const kind of ['memory', 'postgres'] as const) {
  describe(`archive export on the ${kind} adapters`, () => {
    test('by default private notes are absent and counted', async () => {
      const { get, events } = await setup(kind)
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/zip')
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="Acme Guild-archive.zip"'
      )
      expect(counts.parse(JSON.parse(res.headers.get('x-archive-counts') ?? 'null'))).toEqual({
        exported: 1,
        privateIncluded: 0,
        privateLeftOut: 1,
      })
      const { files } = await unzip(res)
      const everything = Object.entries(files)
        .map(([p, t]) => `${p}\n${t}`)
        .join('\n')
      expect(everything).not.toContain(`[[${SECRET_TITLE}`)
      expect(everything).not.toContain(SECRET_BODY)
      expect(Object.keys(files).join('\n')).not.toContain(SECRET_TITLE)
      expect(Object.keys(files).some((p) => p.startsWith('Private/'))).toBe(false)
      expect(Object.values(files).join('\n')).not.toContain('[withheld]')
      expect(await events()).toHaveLength(1)
    })

    test('the default export is identical before and after private notes are added', async () => {
      const { guild, notes, get } = await setup(kind)
      const fact = { kind: 'text', claim: 'fact', evidence: 'seen' } as const
      await notes.add(
        guild,
        {
          ...fact,
          title: 'Linker',
          body: '[[Diary [2026]]] [[Plan|the plan]] [[Plan#Part]] [[Tail]]] [[Notes ]]]]',
        },
        HALL
      )
      const before = await unzip(await get())
      for (const title of ['Diary [2026]', 'Plan', 'Tail]', 'Notes ]]']) {
        await notes.add(guild, { ...fact, title, body: 'hidden' }, HALL, undefined, 'private')
      }
      const res = await get()
      const after = await unzip(res)
      expect(after.files).toEqual(before.files)
      expect(JSON.stringify(after.files)).not.toContain('[withheld]')
      expect(counts.parse(JSON.parse(res.headers.get('x-archive-counts') ?? 'null'))).toEqual({
        exported: 2,
        privateIncluded: 0,
        privateLeftOut: 5,
      })
    })

    test('the zip round-trips: each note file has parseable front matter', async () => {
      const { get } = await setup(kind)
      const { files } = await unzip(await get())
      const path = Object.keys(files).find((p) => p.endsWith('Public one.md'))
      expect(path).toBe('Heralds Hall/Public one.md')
      const text = files[path ?? ''] ?? ''
      const front = z
        .object({ hall: z.string(), trust: z.string(), version: z.number(), kind: z.string() })
        .parse(parse(text.split('---')[1] ?? ''))
      expect(front).toMatchObject({ hall: 'Heralds Hall', trust: 'fact', version: 1, kind: 'text' })
      expect(Object.keys(files)).toContain('Archive.md')
    })

    test('?private=true without proof is 403 and writes nothing', async () => {
      const { get, events, proofsSpent } = await setup(kind)
      const res = await get('?private=true')
      expect(res.status).toBe(403)
      expect(z.object({ error: z.string() }).parse(await res.json()).error).toBe('reauth_required')
      expect(await events()).toHaveLength(0)
      expect(proofsSpent()).toBe(0)
    })

    test('?private=true with proof includes Private/ and counts it', async () => {
      const { get, events } = await setup(kind)
      const res = await get('?private=true', { 'x-reauth-proof': PROOF })
      expect(res.status).toBe(200)
      expect(counts.parse(JSON.parse(res.headers.get('x-archive-counts') ?? 'null'))).toEqual({
        exported: 2,
        privateIncluded: 1,
        privateLeftOut: 0,
      })
      const { files } = await unzip(res)
      const secret = Object.entries(files).find(([p]) => p.startsWith('Private/'))
      expect(secret?.[1]).toContain(SECRET_BODY)
      expect(await events()).toEqual([{ exported: 2, privateIncluded: 1, privateLeftOut: 0 }])
    })

    test('a malformed query is 400 and writes nothing', async () => {
      const { get, events } = await setup(kind)
      expect((await get('?private=maybe')).status).toBe(400)
      expect(await events()).toHaveLength(0)
    })

    test('past the note cap the export is 413 archive_too_large and writes nothing', async () => {
      const { get, events } = await setup(kind, { caps: { maxNotes: 0, maxBytes: 1_000_000 } })
      const res = await get()
      expect(res.status).toBe(413)
      expect(z.object({ error: z.string() }).parse(await res.json()).error).toBe(
        'archive_too_large'
      )
      expect(await events()).toHaveLength(0)
    })

    test('past the byte cap the export is 413 archive_too_large', async () => {
      const { get } = await setup(kind, { caps: { maxNotes: 100, maxBytes: 50 } })
      expect((await get()).status).toBe(413)
    })

    test('a missing guild is 404 before a proof is spent', async () => {
      const { get, proofsSpent } = await setup(kind)
      const ghost = await get('?private=true', { 'x-reauth-proof': PROOF }, 'ghost')
      expect(ghost.status).toBe(404)
      expect(proofsSpent()).toBe(0)
    })

    test('a 413 after the proof is spent still spends it once (the proof is consumed by the check)', async () => {
      const { get, events, proofsSpent } = await setup(kind, {
        caps: { maxNotes: 1, maxBytes: 1_000_000 },
      })
      const res = await get('?private=true', { 'x-reauth-proof': PROOF })
      expect(res.status).toBe(413)
      expect(proofsSpent()).toBe(1)
      expect(await events()).toHaveLength(0)
    })

    test('body bytes alone past maxBytes are 413', async () => {
      const { get } = await setup(kind, { caps: { maxNotes: 100, maxBytes: 40 } })
      // Title and evidence are tiny; the two bodies together exceed 40 bytes.
      expect((await get()).status).toBe(413)
    })

    test.each([
      ['the note count', { maxNotes: 50, maxBytes: 1_000_000 }, 'n'],
      ['title and evidence bytes', { maxNotes: 1000, maxBytes: 5000 }, 'T'.repeat(100)],
    ])(
      'the paging loop stops on the first page past the cap on %s',
      async (_label, caps, title) => {
        const calls = { list: 0 }
        const { guild, notes, get } = await setup(kind, {
          caps,
          wrapNotes: (store) => ({
            add: store.add.bind(store),
            edit: store.edit.bind(store),
            get: store.get.bind(store),
            search: store.search.bind(store),
            countPrivate: store.countPrivate.bind(store),
            list: (g, page) => {
              calls.list++
              return store.list(g, page)
            },
          }),
        })
        for (let i = 0; i < MAX_NOTE_PAGE + 20; i++) {
          await notes.add(
            guild,
            {
              kind: 'text',
              claim: 'fact',
              title: `${title}${i}`,
              body: 'b',
              evidence: 'e'.repeat(20),
            },
            HALL
          )
        }
        expect((await get()).status).toBe(413)
        expect(calls.list).toBe(1)
      }
    )

    test('when zipping throws, no event is written', async () => {
      const { get, events } = await setup(kind, {
        zip: () => {
          throw new Error('zip failed')
        },
      })
      const res = await get()
      expect(res.status).toBe(500)
      expect(await events()).toHaveLength(0)
    })

    test.each([
      ['a"b', 'ab-archive.zip'],
      ['x\r\nSet-Cookie: y', 'xSet-Cookie y-archive.zip'],
      ['\u65e5\u672c', 'guild-archive.zip'],
      ['', 'guild-archive.zip'],
    ])('the download name for guild %j is one clean filename', async (guildName, expected) => {
      if (kind === 'postgres' && guildName === '') {
        return // guilds.name is check-constrained non-empty, so the case only exists in memory
      }
      const { get } = await setup(kind, { guildName })
      const res = await get()
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${expected}"`)
    })

    test('the event payload holds counts only', async () => {
      const { get, events } = await setup(kind)
      await get()
      const [payload] = await events()
      expect(payload).toEqual({ exported: 1, privateIncluded: 0, privateLeftOut: 1 })
      expect(JSON.stringify(payload)).not.toContain(SECRET_TITLE)
    })
  })
}
