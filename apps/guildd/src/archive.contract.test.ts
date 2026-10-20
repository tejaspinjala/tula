import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { eventsAfter } from './events'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'

const harness = await createHarness({ devGuildHeader: true })
const strict = await createHarness({ devGuildHeader: false })
afterAll(async () => {
  await harness.close()
  await strict.close()
})

const noteBody = z.object({ id: z.string(), version: z.number(), trust: z.string() })
const detailBody = z.object({
  note: noteBody,
  versions: z.array(z.object({ version: z.number() })),
  backlinks: z.array(z.object({ id: z.string(), title: z.string() })),
})
const pageBody = z.object({
  notes: z.array(z.object({ id: z.string() })),
  next: z.string().nullable(),
})

const base = (g: string) => `/guilds/${g}/archive/notes`
const headers = (g: string) => ({ 'content-type': 'application/json', 'x-guild-id': g })

function send(g: string, path: string, method: string, body: unknown) {
  return harness.request(path, { method, headers: headers(g), body: JSON.stringify(body) })
}

describe('archive routes', () => {
  test('add, edit and read a note keeps versions; a [[link]] shows as a backlink', async () => {
    const g = await harness.adapters.db.foundGuild({ name: 'Arch', goal: 'g' })
    const target = noteBody.parse(
      await (
        await send(g, base(g), 'POST', {
          kind: 'text',
          title: 'Runbook',
          body: 'steps',
          claim: 'fact',
          evidence: 'ops review',
        })
      ).json()
    )
    const src = await send(g, base(g), 'POST', {
      kind: 'text',
      title: 'Retro',
      body: 'see [[runbook]]',
      claim: 'assumption',
    })
    expect(src.status).toBe(201)
    expect(noteBody.parse(await src.json()).trust).toBe('quarantined')
    const edit = await send(g, `${base(g)}/${target.id}`, 'PATCH', { body: 'new steps' })
    expect(noteBody.parse(await edit.json()).version).toBe(2)
    const got = await harness.request(`${base(g)}/${target.id}`, { headers: headers(g) })
    const detail = detailBody.parse(await got.json())
    expect(detail.versions).toHaveLength(2)
    expect(detail.backlinks.map((b) => b.title)).toEqual(['Retro'])
  })

  test('a fact without evidence is 422; bad input is 400; unknown note is 404', async () => {
    const g = await harness.adapters.db.foundGuild({ name: 'Arch', goal: 'g' })
    const noEvidence = await send(g, base(g), 'POST', {
      kind: 'text',
      title: 'T',
      body: 'b',
      claim: 'fact',
    })
    expect(noEvidence.status).toBe(422)
    const bad = await send(g, base(g), 'POST', {
      kind: 'link',
      title: 'T',
      body: 'nope',
      claim: 'assumption',
    })
    expect(bad.status).toBe(400)
    const missing = await send(g, `${base(g)}/${crypto.randomUUID()}`, 'PATCH', { title: 'x' })
    expect(missing.status).toBe(404)
  })

  test('search and list are paginated and scoped to the guild', async () => {
    const g = await harness.adapters.db.foundGuild({ name: 'Arch', goal: 'g' })
    const other = await harness.adapters.db.foundGuild({ name: 'Other', goal: 'g' })
    for (const [guild, title] of [
      [g, 'one'],
      [g, 'two'],
      [other, 'three'],
    ] as const) {
      await send(guild, base(guild), 'POST', {
        kind: 'text',
        title,
        body: 'quokka habitat',
        claim: 'assumption',
      })
    }
    const hits = await harness.request(`${base(g)}?q=quokka&limit=1`, { headers: headers(g) })
    const page = pageBody.parse(await hits.json())
    expect(page.notes).toHaveLength(1)
    expect(page.next).not.toBeNull()
    const all = pageBody.parse(
      await (await harness.request(`${base(g)}?limit=10`, { headers: headers(g) })).json()
    )
    expect(all.notes).toHaveLength(2)
    expect((await harness.request(`${base(g)}?limit=0`, { headers: headers(g) })).status).toBe(400)
  })

  test('note writes land on the event stream', async () => {
    const g = await harness.adapters.db.foundGuild({ name: 'Arch', goal: 'g' })
    const n = noteBody.parse(
      await (
        await send(g, base(g), 'POST', { kind: 'text', title: 'E', body: 'b', claim: 'assumption' })
      ).json()
    )
    await send(g, `${base(g)}/${n.id}`, 'PATCH', { body: 'c' })
    const events = await harness.adapters.db.withGuild(g, (tx) => eventsAfter(tx, 0))
    expect(events.map((e) => e.type).filter((t) => t.startsWith('note.'))).toEqual([
      'note.added',
      'note.edited',
    ])
  })

  test('without a session the routes answer 401', async () => {
    const g = await strict.adapters.db.foundGuild({ name: 'Arch', goal: 'g' })
    const res = await strict.request(base(g), { headers: { 'x-guild-id': g } })
    expect(res.status).toBe(401)
  })

  test('cross-guild probes: another guild looks like a missing one', async () => {
    const note = (caller: string, target: string): [string, RequestInit] => [
      base(target),
      {
        method: 'POST',
        headers: headers(caller),
        body: JSON.stringify({ kind: 'text', title: 'x', body: 'y', claim: 'assumption' }),
      },
    ]
    const snapshot = (g: string) => harness.adapters.notes.list(g, { limit: 100 })
    await expectGuildIsolation(harness, { build: note, snapshot })
    await expectGuildIsolation(harness, {
      build: (caller, target) => [`${base(target)}?q=anything`, { headers: headers(caller) }],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `${base(target)}/${crypto.randomUUID()}`,
        { headers: headers(caller) },
      ],
      snapshot,
    })
  })
})
