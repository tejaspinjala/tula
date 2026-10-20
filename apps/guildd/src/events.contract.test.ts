import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { appendEvent, eventsAfter } from './events'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())
const { db } = harness.adapters

describe('event log', () => {
  test('appending for a guild that was never founded raises and writes nothing', async () => {
    const ghost = crypto.randomUUID()
    await expect(db.withGuild(ghost, (tx) => appendEvent(tx, 'test.ghost', {}))).rejects.toThrow()
    const rows = await harness.owner`select 1 from events where guild_id = ${ghost}`
    expect(rows.length).toBe(0)
  })

  test('founding a guild appends exactly one guild.founded event with seq 1', async () => {
    const id = await db.foundGuild({ name: 'Ember', goal: 'Ship' })
    const events = await db.withGuild(id, (tx) => eventsAfter(tx, 0))
    expect(events.map((e) => [e.seq, e.type])).toEqual([[1, 'guild.founded']])
    expect(events[0]?.payload).toEqual({ name: 'Ember', goal: 'Ship' })
  })

  test('a rolled-back transaction leaves no event and no seq gap', async () => {
    const id = await db.foundGuild({ name: 'Ember', goal: 'Ship' })
    await db
      .withGuild(id, async (tx) => {
        await appendEvent(tx, 'test.happened', {})
        throw new Error('boom')
      })
      .catch(() => {})
    await db.withGuild(id, (tx) => appendEvent(tx, 'test.kept', {}))
    const events = await db.withGuild(id, (tx) => eventsAfter(tx, 0))
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'guild.founded'],
      [2, 'test.kept'],
    ])
  })

  test('concurrent appends get distinct, gap-free seqs', async () => {
    const id = await db.foundGuild({ name: 'Ember', goal: 'Ship' })
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db.withGuild(id, (tx) => appendEvent(tx, 'test.n', { i }))
      )
    )
    const events = await db.withGuild(id, (tx) => eventsAfter(tx, 0, 100))
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
  })

  test('the events table rejects updates and deletes, even from the owner', async () => {
    const id = await db.foundGuild({ name: 'Ember', goal: 'Ship' })
    const run = (fn: (tx: Parameters<Parameters<typeof db.withGuild>[1]>[0]) => unknown) =>
      db
        .withGuild(id, async (tx) => fn(tx))
        .then(
          () => 'ok',
          (e: Error) => e.message
        )
    expect(await run((tx) => tx`update events set type = 'x'`)).toContain('permission denied')
    expect(await run((tx) => tx`delete from events`)).toContain('permission denied')
    expect(
      await run((tx) => tx`insert into events (guild_id, seq, type) values (${id}, 99, 'x')`)
    ).toContain('permission denied')
    const ownerAttempt = await harness.owner.unsafe('update events set type = $1', ['x']).then(
      () => 'ok',
      (e: Error) => e.message
    )
    expect(ownerAttempt).toContain('append-only')
  })

  test('one guild never reads another guild events', async () => {
    const a = await db.foundGuild({ name: 'A', goal: 'g' })
    await db.foundGuild({ name: 'B', goal: 'g' })
    const events = await db.withGuild(a, (tx) => eventsAfter(tx, 0, 100))
    expect(events.length).toBe(1)
  })
})

describe('event stream route', () => {
  test('GET /guilds/:id/events as another guild is indistinguishable from a missing guild', async () => {
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `/guilds/${target}/events`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: (id) => db.withGuild(id, (tx) => eventsAfter(tx, 0, 100)),
    })
  })
})

const FrameSchema = z.object({
  type: z.string(),
  head: z.number().optional(),
  seq: z.number().optional(),
  event: z.object({ seq: z.number() }).optional(),
})
type Frame = z.infer<typeof FrameSchema>

/** Opens the stream and collects frames until `until` says enough. */
function stream(base: string, guild: string, lastSeq: number, until: (f: Frame[]) => boolean) {
  return new Promise<Frame[]>((resolve, reject) => {
    const frames: Frame[] = []
    const ws = new WebSocket(`${base}/guilds/${guild}/events?last_seq=${lastSeq}`, {
      headers: { 'x-guild-id': guild },
    })
    const timer = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(frames)}`)), 3000)
    ws.onmessage = (m) => {
      frames.push(FrameSchema.parse(JSON.parse(String(m.data))))
      if (until(frames)) {
        clearTimeout(timer)
        ws.close()
        resolve(frames)
      }
    }
    ws.onerror = () => reject(new Error('socket error'))
  })
}

describe('event stream over WebSocket', () => {
  test('reconnecting with last_seq delivers a snapshot marker then only missed events, in order', async () => {
    const base = harness.listen()
    const id = await db.foundGuild({ name: 'Ember', goal: 'Ship' })
    const first = await stream(base, id, 0, (f) => f.length === 2)
    expect(first.map((f) => [f.type, f.event?.seq ?? f.head])).toEqual([
      ['snapshot', 1],
      ['event', 1],
    ])
    for (const n of [2, 3]) {
      await db.withGuild(id, (tx) => appendEvent(tx, `test.${n}`, {}))
    }
    const live = stream(base, id, 1, (f) => f.length === 4)
    await db.withGuild(id, (tx) => appendEvent(tx, 'test.4', {}))
    const frames = await live
    expect(frames[0]?.type).toBe('snapshot')
    expect(frames.slice(1).map((f) => [f.type, f.event?.seq])).toEqual([
      ['event', 2],
      ['event', 3],
      ['event', 4],
    ])
  })

  test('never delivers another guild events, and refuses a foreign guild', async () => {
    const base = harness.listen()
    const a = await db.foundGuild({ name: 'A', goal: 'g' })
    const b = await db.foundGuild({ name: 'B', goal: 'g' })
    await db.withGuild(b, (tx) => appendEvent(tx, 'secret.b', {}))
    const frames = await stream(base, a, 0, (f) => f.length === 2)
    expect(JSON.stringify(frames)).not.toContain('secret.b')
    const foreign = await fetch(`${base.replace('ws', 'http')}/guilds/${b}/events`, {
      headers: { 'x-guild-id': a },
    })
    expect(foreign.status).toBe(404)
  })
})
