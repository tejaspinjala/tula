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
import type { NoteStore } from '../ports/note-store'
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
async function setup(kind: 'memory' | 'postgres', caps?: { maxNotes: number; maxBytes: number }) {
  const keys = new MemoryKeyProvider()
  const guild =
    kind === 'memory'
      ? crypto.randomUUID()
      : await foundTestGuild(db, { name: 'Acme Guild', goal: 'g' }, keys)
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
    notes,
    config,
    clock,
    guildName: async (id) => (id === guild ? 'Acme Guild' : null),
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
  })
  const events = async (): Promise<unknown[]> => {
    if (kind === 'memory') {
      return memoryEvents
    }
    const rows =
      await owner`select payload from events where guild_id = ${guild} and type = ${ARCHIVE_EVENT.exported}`
    return rows.map((r) => r.payload)
  }
  const get = (query = '', headers: Record<string, string> = {}) =>
    app.request(`/guilds/${guild}/archive/export${query}`, { headers })
  return { guild, get, events, proofsSpent: () => proofsSpent }
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
    test('by default private notes are absent, withheld in links, and counted', async () => {
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
      const { bytes, files } = await unzip(res)
      const everything = Object.entries(files)
        .map(([p, t]) => `${p}\n${t}`)
        .join('\n')
      expect(everything).not.toContain(SECRET_TITLE)
      expect(everything).not.toContain(SECRET_BODY)
      expect(new TextDecoder('latin1').decode(bytes)).not.toContain(SECRET_TITLE)
      expect(Object.keys(files).some((p) => p.startsWith('Private/'))).toBe(false)
      expect(Object.values(files).join('\n')).toContain('[withheld]')
      expect(await events()).toHaveLength(1)
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
      const { get, events } = await setup(kind, { maxNotes: 1, maxBytes: 1_000_000 })
      const res = await get()
      expect(res.status).toBe(413)
      expect(z.object({ error: z.string() }).parse(await res.json()).error).toBe(
        'archive_too_large'
      )
      expect(await events()).toHaveLength(0)
    })

    test('past the byte cap the export is 413 archive_too_large', async () => {
      const { get } = await setup(kind, { maxNotes: 100, maxBytes: 50 })
      expect((await get()).status).toBe(413)
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
