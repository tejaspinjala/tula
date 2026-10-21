import { afterAll, describe, expect, test } from 'bun:test'
import type { JSONValue } from 'postgres'
import { z } from 'zod'
import { appendEvent, headSeq } from './events'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const entry = z.object({
  seq: z.number(),
  kind: z.string(),
  occurredAt: z.string(),
  questId: z.string().nullable(),
  sessionId: z.string().nullable(),
  sealId: z.string().nullable(),
  reason: z.string().nullable(),
  amountCents: z.number().nullable(),
})
const digest = z.object({
  window: z
    .object({ since: z.string(), until: z.string().nullable(), open: z.boolean() })
    .nullable(),
  entries: z.array(entry),
  next: z.number().nullable(),
})

async function found() {
  const guild = await harness.foundGuild({ name: 'Digest', goal: 'g' })
  return { guild, token: await openSession(harness.adapters.identity, guild) }
}

function emit(guild: string, type: string, payload: JSONValue): Promise<number> {
  return harness.adapters.db.withGuild(guild, (tx) =>
    appendEvent(tx, harness.adapters.keys, type, payload)
  )
}

const away = (guild: string, until: string | null = null) =>
  emit(guild, 'guildmaster.away', { since: new Date().toISOString(), until })

const done = (guild: string, questId: string) =>
  emit(guild, 'quest.done', { questId, hallId: 'h', attempt: 1 })

async function read(guild: string, token: string, query = '') {
  const res = await harness.request(`/guilds/${guild}/guild-master/away-digest${query}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status).toBe(200)
  return digest.parse(await res.json())
}

describe('GET /guilds/:id/guild-master/away-digest', () => {
  test('a guild that never went away has no window and no entries', async () => {
    const { guild, token } = await found()
    expect(await read(guild, token)).toEqual({ window: null, entries: [], next: null })
  })

  test('returns exactly the events between away and returned', async () => {
    const { guild, token } = await found()
    await done(guild, 'before')
    await away(guild)
    await emit(guild, 'council.approved', { sessionId: 's1', questId: 'q1', proposalHash: 'h' })
    await emit(guild, 'council.escalated', {
      sessionId: 's2',
      questId: 'q2',
      proposalHash: 'h',
      reason: 'blocked',
    })
    await done(guild, 'q1')
    await emit(guild, 'treasury.spend', {
      spendId: 'sp1',
      status: 'approved',
      amountCents: 250,
      memberId: 'm',
    })
    await emit(guild, 'seal.requested', { sealId: 'seal-wait', questId: 'q2', actionHash: 'x' })
    await emit(guild, 'seal.requested', { sealId: 'seal-done', questId: 'q3', actionHash: 'x' })
    await emit(guild, 'seal.approved', { sealId: 'seal-done', questId: 'q3', actionHash: 'x' })
    await emit(guild, 'guildmaster.returned', { since: 'x' })
    await done(guild, 'after')

    const page = await read(guild, token)
    expect(page.window?.open).toBe(false)
    expect(
      page.entries.map((e) => [
        e.kind,
        e.questId ?? e.sealId ?? e.sessionId,
        e.reason,
        e.amountCents,
      ])
    ).toEqual([
      ['council_approved', 'q1', null, null],
      ['escalated', 'q2', 'blocked', null],
      ['quest_done', 'q1', null, null],
      ['spend', null, null, 250],
      ['seal_waiting', 'q2', null, null],
    ])
  })

  test('an away that has not ended runs to now and reads as open', async () => {
    const { guild, token } = await found()
    await away(guild)
    await done(guild, 'q1')
    const page = await read(guild, token)
    expect(page.window?.open).toBe(true)
    expect(page.entries.map((e) => e.questId)).toEqual(['q1'])
  })

  test('a lapsed return time ends the window at until, not at the later return', async () => {
    // The harness clock is a memory clock; step it past the real instants the events carry,
    // before the session is opened so the session is not born expired.
    harness.adapters.clock.advance(400 * 86_400_000)
    const { guild, token } = await found()
    await away(guild, new Date(Date.now() + 400).toISOString())
    await done(guild, 'inside')
    await Bun.sleep(800)
    await done(guild, 'late')
    const lapsed = await read(guild, token)
    expect(lapsed.window?.open).toBe(false)
    expect(lapsed.entries.map((e) => e.questId)).toEqual(['inside'])
    await emit(guild, 'guildmaster.returned', { since: 'x' })
    expect((await read(guild, token)).entries.map((e) => e.questId)).toEqual(['inside'])
  })

  test('only the latest away window is read', async () => {
    const { guild, token } = await found()
    await away(guild)
    await done(guild, 'old')
    await emit(guild, 'guildmaster.returned', { since: 'x' })
    await away(guild)
    await done(guild, 'new')
    expect((await read(guild, token)).entries.map((e) => e.questId)).toEqual(['new'])
  })

  test('pages by seq cursor with a limit', async () => {
    const { guild, token } = await found()
    await away(guild)
    for (const q of ['a', 'b', 'c']) {
      await done(guild, q)
    }
    const first = await read(guild, token, '?limit=2')
    expect(first.entries.map((e) => e.questId)).toEqual(['a', 'b'])
    expect(first.next).not.toBeNull()
    const second = await read(guild, token, `?limit=2&after=${first.next}`)
    expect(second.entries.map((e) => e.questId)).toEqual(['c'])
    expect(second.next).toBeNull()
    const bad = await harness.request(`/guilds/${guild}/guild-master/away-digest?limit=0`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(bad.status).toBe(400)
  })

  test('needs a session', async () => {
    const { guild } = await found()
    expect((await harness.request(`/guilds/${guild}/guild-master/away-digest`)).status).toBe(401)
  })

  test('is isolated per guild', async () => {
    const caller = await found()
    const mine = await found()
    await away(mine.guild)
    await done(mine.guild, 'secret')
    await expectGuildIsolation(harness, {
      build: (_c, target) => [
        `/guilds/${target}/guild-master/away-digest`,
        { headers: { authorization: `Bearer ${caller.token}` } },
      ],
      snapshot: (g) => harness.adapters.db.withGuild(g, (tx) => headSeq(tx)),
    })
    const own = await read(mine.guild, mine.token)
    expect(own.entries.map((e) => e.questId)).toEqual(['secret'])
    expect((await read(caller.guild, caller.token)).entries).toEqual([])
  })
})
