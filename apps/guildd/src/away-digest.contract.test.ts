import { afterAll, describe, expect, test } from 'bun:test'
import type { JSONValue } from 'postgres'
import { z } from 'zod'
import { appendEvent, headSeq } from './events'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const Q = {
  q1: crypto.randomUUID(),
  q2: crypto.randomUUID(),
  q3: crypto.randomUUID(),
  q4: crypto.randomUUID(),
  q9: crypto.randomUUID(),
}
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
  status: z.string().nullable(),
})
const digest = z.object({
  window: z
    .object({ since: z.string(), until: z.string().nullable(), open: z.boolean() })
    .nullable(),
  entries: z.array(entry),
  next: z.number().nullable(),
  spendTotalCents: z.number(),
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
    expect(await read(guild, token)).toEqual({
      window: null,
      entries: [],
      next: null,
      spendTotalCents: 0,
    })
  })

  async function session(guild: string, questId: string, hash: string): Promise<string> {
    const opened = await harness.adapters.councilStore.open(guild, {
      questId,
      proposalHash: hash.repeat(64),
      day: '2026-01-01',
      sessionCap: 50,
    })
    if (opened.status === 'cap_reached') {
      throw new Error('cap')
    }
    return opened.session.id
  }

  function seal(guild: string, questId: string) {
    return harness.adapters.sealStore.request(guild, {
      questId,
      requestedBy: 'm',
      kind: 'post',
      text: `text ${questId}`,
      evidence: 'e',
    })
  }

  test('returns exactly the window, with the real Council and Seal events', async () => {
    const { guild, token } = await found()
    await done(guild, 'before')
    await away(guild)
    // Approved by the Council: one line, the Quest's own quest.done folds into it.
    const approvedSeal = await seal(guild, Q.q1)
    const s1 = await session(guild, Q.q1, 'a')
    await harness.adapters.councilStore.approve(guild, s1, {
      questId: Q.q1,
      day: '2026-01-01',
      cap: 5,
    })
    await harness.adapters.sealStore.councilApprove(guild, approvedSeal.id, {
      sessionId: s1,
      expectedHash: approvedSeal.actionHash,
    })
    await done(guild, Q.q1)
    const s2 = await session(guild, Q.q2, 'b')
    await harness.adapters.councilStore.escalate(guild, s2, 'blocked')
    const s3 = await session(guild, Q.q3, 'c')
    await harness.adapters.councilStore.halt(guild, s3, Q.q3)
    await done(guild, Q.q4)
    const waiting = await seal(guild, Q.q2)
    await emit(guild, 'guildmaster.returned', { since: 'x' })
    await done(guild, 'after')

    const page = await read(guild, token)
    expect(page.window?.open).toBe(false)
    expect(page.entries.map((e) => [e.kind, e.questId, e.sessionId, e.sealId, e.reason])).toEqual([
      ['council_approved', Q.q1, s1, null, null],
      ['escalated', Q.q2, s2, null, 'blocked'],
      ['council_halted', Q.q3, s3, null, null],
      ['quest_done', Q.q4, null, null, null],
      ['seal_waiting', Q.q2, null, waiting.id, null],
    ])
  })

  test('a Seal past its time to live no longer lists as waiting', async () => {
    const { guild, token } = await found()
    await away(guild)
    const stale = await seal(guild, Q.q9)
    expect((await read(guild, token)).entries.map((e) => e.sealId)).toEqual([stale.id])
    harness.adapters.clock.advance(73 * 3_600_000)
    const reopened = await openSession(harness.adapters.identity, guild)
    expect((await read(guild, reopened)).entries).toEqual([])
  })

  test('a spend counts once at its final amount, and the window totals them', async () => {
    const { guild, token } = await found()
    await away(guild)
    const spend = (spendId: string, status: string, amountCents: number) =>
      emit(guild, 'treasury.spend', { spendId, status, amountCents, memberId: 'm' })
    await spend('sp1', 'reserved', 500)
    await spend('sp1', 'settled', 320)
    await spend('sp2', 'reserved', 100)
    await spend('sp2', 'released', 100)
    await spend('sp3', 'pending_approval', 900)
    const page = await read(guild, token)
    expect(page.entries.map((e) => [e.kind, e.amountCents, e.status])).toEqual([
      ['spend', 320, 'settled'],
      ['spend', 100, 'released'],
      ['spend', 900, 'pending_approval'],
    ])
    expect(page.spendTotalCents).toBe(320)
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
