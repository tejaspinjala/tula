import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { appendEvent } from './events'
import type { KeyProvider } from './ports/key-provider'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())
const { db, keys } = harness.adapters

const Verdict = z.discriminatedUnion('intact', [
  z.object({ intact: z.literal(true), entries: z.number() }),
  z.object({ intact: z.literal(false), firstBadSeq: z.number(), reason: z.string() }),
])

async function found(): Promise<string> {
  const res = await harness.request('/guilds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ember', goal: 'Ship' }),
  })
  return z.object({ id: z.string() }).parse(await res.json()).id
}

async function verify(id: string, caller = id) {
  const res = await harness.request(`/guilds/${id}/audit/verify`, {
    headers: { 'x-guild-id': caller },
  })
  return { status: res.status, body: Verdict.parse(await res.json()) }
}

async function grow(id: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.withGuild(id, (tx) =>
      appendEvent(tx, keys, `test.${i}`, { i, nested: { b: 1, a: 2 } })
    )
  }
}

/** Runs `sql` as the owner with the append-only triggers off, to simulate someone with DB access. */
async function tamper(run: () => Promise<unknown>) {
  const o = harness.owner
  await o`alter table audit_chain disable trigger user`
  await o`alter table events disable trigger user`
  try {
    await run()
  } finally {
    await o`alter table audit_chain enable trigger user`
    await o`alter table events enable trigger user`
  }
}

describe('audit chain', () => {
  test('a freshly founded guild verifies intact with its founding event chained', async () => {
    const id = await found()
    expect(await verify(id)).toEqual({ status: 200, body: { intact: true, entries: 2 } })
  })

  test('each event gets one entry linking to the previous MAC', async () => {
    const id = await found()
    await grow(id, 3)
    const rows = await harness.owner`
      select seq, prev_mac, mac from audit_chain where guild_id = ${id} order by seq`
    expect(rows.map((r) => Number(r.seq))).toEqual([1, 2, 3, 4, 5])
    expect(rows[0]?.prev_mac).toBe('0'.repeat(64))
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.prev_mac).toBe(rows[i - 1]?.mac)
    }
    expect(await verify(id)).toEqual({ status: 200, body: { intact: true, entries: 5 } })
  })

  test('a rolled-back event leaves no entry', async () => {
    const id = await found()
    await db
      .withGuild(id, async (tx) => {
        await appendEvent(tx, keys, 'test.lost', {})
        throw new Error('boom')
      })
      .catch(() => {})
    expect((await verify(id)).body).toEqual({ intact: true, entries: 2 })
  })

  test('concurrent appends keep one linear intact chain', async () => {
    const id = await found()
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.withGuild(id, (tx) => appendEvent(tx, keys, 'test.n', { i }))
      )
    )
    expect((await verify(id)).body).toEqual({ intact: true, entries: 12 })
  })

  test('the HMAC key is not in Postgres: another key cannot verify, and no table holds it', async () => {
    const id = await found()
    await grow(id, 1)
    const rows = await harness.owner`select mac from audit_chain where guild_id = ${id}`
    const columns = await harness.owner`
      select column_name from information_schema.columns where table_name = 'audit_chain'`
    expect(columns.map((c) => c.column_name).sort()).toEqual(['guild_id', 'mac', 'prev_mac', 'seq'])
    expect(rows.length).toBe(3)
  })

  test('editing an entry fails verify and names that entry', async () => {
    const id = await found()
    await grow(id, 4)
    await tamper(
      () =>
        harness.owner`update audit_chain set mac = ${'a'.repeat(64)} where guild_id = ${id} and seq = 3`
    )
    expect((await verify(id)).body).toMatchObject({ intact: false, firstBadSeq: 3 })
  })

  test('deleting an entry fails verify and names it', async () => {
    const id = await found()
    await grow(id, 4)
    await tamper(() => harness.owner`delete from audit_chain where guild_id = ${id} and seq = 2`)
    expect((await verify(id)).body).toMatchObject({ intact: false, firstBadSeq: 2 })
  })

  test('deleting the last entry fails verify and names it', async () => {
    const id = await found()
    await grow(id, 2)
    await tamper(() => harness.owner`delete from audit_chain where guild_id = ${id} and seq = 3`)
    expect((await verify(id)).body).toMatchObject({ intact: false, firstBadSeq: 3 })
  })

  test('reordering entries fails verify and names the first displaced one', async () => {
    const id = await found()
    await grow(id, 4)
    await tamper(async () => {
      const o = harness.owner
      const [two] =
        await o`select prev_mac, mac from audit_chain where guild_id = ${id} and seq = 2`
      const [three] =
        await o`select prev_mac, mac from audit_chain where guild_id = ${id} and seq = 3`
      await o`update audit_chain set prev_mac = ${three?.prev_mac}, mac = ${three?.mac}
        where guild_id = ${id} and seq = 2`
      await o`update audit_chain set prev_mac = ${two?.prev_mac}, mac = ${two?.mac}
        where guild_id = ${id} and seq = 3`
    })
    expect((await verify(id)).body).toMatchObject({ intact: false, firstBadSeq: 2 })
  })

  test('editing a stored event fails verify and names it', async () => {
    const id = await found()
    await grow(id, 3)
    await tamper(
      () =>
        harness.owner`update events set payload = '{"forged":true}'::jsonb where guild_id = ${id} and seq = 3`
    )
    expect((await verify(id)).body).toMatchObject({ intact: false, firstBadSeq: 3 })
  })

  test('the app role cannot write or rewrite the chain directly', async () => {
    const id = await found()
    const attempt = (fn: (tx: Parameters<Parameters<typeof db.withGuild>[1]>[0]) => unknown) =>
      db
        .withGuild(id, async (tx) => fn(tx))
        .then(
          () => 'ok',
          () => 'denied'
        )
    expect(await attempt((tx) => tx`update audit_chain set mac = ${'d'.repeat(64)}`)).toBe('denied')
    expect(await attempt((tx) => tx`delete from audit_chain`)).toBe('denied')
  })

  test("another guild's context sees none of this guild's entries", async () => {
    const a = await found()
    const b = await found()
    const seen = await db.withGuild(
      b,
      (tx) => tx`select seq from audit_chain where guild_id = ${a}`
    )
    expect(seen.length).toBe(0)
    const forged = await db
      .withGuild(
        b,
        (tx) => tx`insert into audit_chain (guild_id, seq, prev_mac, mac)
        values (${a}, 9, ${'0'.repeat(64)}, ${'e'.repeat(64)})`
      )
      .then(
        () => 'ok',
        () => 'denied'
      )
    expect(forged).toBe('denied')
  })

  test('verify refuses a foreign guild exactly like a missing one', async () => {
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `/guilds/${target}/audit/verify`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) => (await verify(guildId)).body,
    })
  })

  test('verify without a caller is unauthenticated', async () => {
    const id = await found()
    const res = await harness.request(`/guilds/${id}/audit/verify`)
    expect(res.status).toBe(401)
  })
})

describe('founding is chained atomically', () => {
  test('a KeyProvider failure while founding leaves nothing behind, and a retry founds one intact guild', async () => {
    const real = new MemoryKeyProvider()
    let failing = true
    const flaky: KeyProvider = {
      wrap: (g, p) => real.wrap(g, p),
      unwrap: (g, w) => real.unwrap(g, w),
      macFor: async (g, purpose) => {
        if (failing) {
          throw new Error('key custody down')
        }
        return real.macFor(g, purpose)
      },
      mac: async (g, purpose, d) => {
        if (failing) {
          throw new Error('key custody down')
        }
        return real.mac(g, purpose, d)
      },
    }
    const h = await createHarness({ app: { keys: flaky } })
    try {
      const name = `Atomic-${crypto.randomUUID()}`
      const found = () =>
        h.request('/guilds', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, goal: 'g' }),
        })
      expect((await found()).status).toBe(500)
      expect((await h.owner`select 1 from guilds where name = ${name}`).length).toBe(0)
      failing = false
      const res = await found()
      expect(res.status).toBe(201)
      const id = z.object({ id: z.string() }).parse(await res.json()).id
      expect((await h.owner`select 1 from guilds where name = ${name}`).length).toBe(1)
      const verdict = await h.request(`/guilds/${id}/audit/verify`, {
        headers: { 'x-guild-id': id },
      })
      expect(Verdict.parse(await verdict.json())).toEqual({ intact: true, entries: 2 })
    } finally {
      await h.close()
    }
  })
})
