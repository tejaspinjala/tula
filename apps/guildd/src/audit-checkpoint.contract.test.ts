import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { bindVerifyTimeout, signCheckpoint } from './audit-chain'
import { appendEvent } from './events'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())
const { db, keys, anchor } = harness.adapters

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const founded = z.object({ id: z.string(), foundingToken: z.string() })
const tokenBody = z.object({ token: z.string() })
const proofBody = z.object({ proof: z.string() })
const Verdict = z.union([
  z.object({ intact: z.literal(true), entries: z.number() }),
  z.object({
    intact: z.literal(true),
    partial: z.literal(true),
    verifiedThrough: z.number(),
    cursor: z.string(),
  }),
  z.object({ intact: z.literal(false), firstBadSeq: z.number(), reason: z.string() }),
])
const Checkpoint = z.object({
  seq: z.number(),
  mac: z.string(),
  signature: z.string(),
  complete: z.boolean(),
})

function post(path: string, body: unknown, headers = {}) {
  return harness.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

async function guildMaster() {
  const f = founded.parse(await (await post('/guilds', { name: 'Audit', goal: 'g' })).json())
  const id = f.id
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const reg = ceremony.parse(
    await (
      await post(`/guilds/${id}/passkeys/begin`, {}, { 'x-founding-token': f.foundingToken })
    ).json()
  )
  await post(`/guilds/${id}/passkeys/finish`, {
    challengeId: reg.challengeId,
    response: await key.register(reg.options),
  })
  const begin = ceremony.parse(await (await post(`/guilds/${id}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${id}/sign-in/finish`, {
    challengeId: begin.challengeId,
    response: await key.assert(begin.options),
  })
  const auth = { authorization: `Bearer ${tokenBody.parse(await res.json()).token}` }
  async function proof() {
    const b = ceremony.parse(await (await post('/session/reauth/begin', {}, auth)).json())
    const done = await post(
      '/session/reauth/finish',
      { challengeId: b.challengeId, response: await key.assert(b.options) },
      auth
    )
    return proofBody.parse(await done.json()).proof
  }
  return {
    id,
    auth,
    async verify(query = '') {
      const res = await harness.request(`/guilds/${id}/audit/verify${query}`, { headers: auth })
      return { status: res.status, body: await res.json() }
    },
    async verdict(query = '') {
      return Verdict.parse((await this.verify(query)).body)
    },
    /** Signs the day's checkpoint with a fresh re-authentication. */
    async checkpoint(body: unknown = {}) {
      const res = await post(`/guilds/${id}/audit/checkpoints`, body, {
        ...auth,
        'x-reauth-proof': await proof(),
      })
      return { status: res.status, body: await res.json() }
    },
  }
}

async function grow(id: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.withGuild(id, (tx) => appendEvent(tx, keys, `test.${i}`, { i }))
  }
}

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

describe('audit checkpoints', () => {
  test('signing the checkpoint needs a fresh re-authentication', async () => {
    const gm = await guildMaster()
    const res = await post(`/guilds/${gm.id}/audit/checkpoints`, {}, gm.auth)
    expect(res.status).toBe(403)
  })

  test('the Guild Master signs the chain head; it is anchored outside Postgres and recorded', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 2)
    const { status, body } = await gm.checkpoint()
    expect(status).toBe(201)
    const cp = Checkpoint.parse(body)
    const [head] = await harness.owner`
      select seq, mac from audit_chain where guild_id = ${gm.id} order by seq desc limit 1`
    expect(cp).toMatchObject({ seq: Number(head?.seq), mac: head?.mac, complete: true })
    expect(cp.signature).toBe(
      await keys.mac(
        gm.id,
        'audit-checkpoint',
        new TextEncoder().encode(`${gm.id}:${cp.seq}:${cp.mac}`)
      )
    )
    expect(await anchor.latest(gm.id)).toEqual({
      seq: cp.seq,
      mac: cp.mac,
      signature: cp.signature,
    })
    const rows = await harness.owner`select seq from audit_checkpoints where guild_id = ${gm.id}`
    expect(rows.map((r) => Number(r.seq))).toEqual([cp.seq])
  })

  test('signing again with nothing new is idempotent', async () => {
    const gm = await guildMaster()
    // Two signings at the same position (the re-authentication itself appends events, so go direct).
    const sign = () => db.withGuild(gm.id, (tx) => signCheckpoint(tx, keys, anchor))
    const first = await sign()
    const second = await sign()
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    const rows = await harness.owner`select 1 from audit_checkpoints where guild_id = ${gm.id}`
    expect(rows.length).toBe(1)
  })

  test('deleting the newest event and its chain entry after a checkpoint fails verify', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 3)
    const cp = Checkpoint.parse((await gm.checkpoint()).body)
    expect(await gm.verdict()).toMatchObject({ intact: true })
    await tamper(async () => {
      await harness.owner`delete from audit_chain where guild_id = ${gm.id} and seq = ${cp.seq}`
      await harness.owner`delete from events where guild_id = ${gm.id} and seq = ${cp.seq}`
    })
    expect(await gm.verdict()).toMatchObject({ intact: false, firstBadSeq: cp.seq })
  })

  test('deleting the database checkpoints as well does not hide the truncation', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 2)
    const cp = Checkpoint.parse((await gm.checkpoint()).body)
    await tamper(async () => {
      await harness.owner`alter table audit_checkpoints disable trigger user`
      await harness.owner`delete from audit_checkpoints where guild_id = ${gm.id}`
      await harness.owner`alter table audit_checkpoints enable trigger user`
      await harness.owner`delete from audit_chain where guild_id = ${gm.id} and seq = ${cp.seq}`
      await harness.owner`delete from events where guild_id = ${gm.id} and seq = ${cp.seq}`
    })
    expect(await gm.verdict()).toMatchObject({ intact: false, firstBadSeq: cp.seq })
  })

  test('a forged anchor entry (wrong signature) fails verify', async () => {
    const gm = await guildMaster()
    await anchor.publish(gm.id, { seq: 99, mac: 'f'.repeat(64), signature: '0'.repeat(64) })
    expect(await gm.verdict()).toMatchObject({
      intact: false,
      reason: expect.stringContaining('signature'),
    })
  })
})

describe('bounded, resumable verification', () => {
  test('a chain larger than the limit returns a cursor, and resuming finishes intact', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 9)
    const [{ n } = { n: 0 }] =
      await harness.owner`select count(*)::int as n from audit_chain where guild_id = ${gm.id}`
    let verdict = await gm.verdict('?limit=3')
    const pages: number[] = []
    while ('partial' in verdict) {
      pages.push(verdict.verifiedThrough)
      verdict = await gm.verdict(`?limit=3&cursor=${encodeURIComponent(verdict.cursor)}`)
    }
    expect(pages.length).toBeGreaterThan(1)
    expect(pages).toEqual([...pages].sort((a, b) => a - b))
    expect(verdict).toEqual({ intact: true, entries: n })
  })

  test('tampering past the first page is found when resuming', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 9)
    await tamper(
      () =>
        harness.owner`update audit_chain set mac = ${'a'.repeat(64)} where guild_id = ${gm.id} and seq = 8`
    )
    let verdict = await gm.verdict('?limit=3')
    while ('partial' in verdict) {
      verdict = await gm.verdict(`?limit=3&cursor=${encodeURIComponent(verdict.cursor)}`)
    }
    expect(verdict).toMatchObject({ intact: false, firstBadSeq: 8 })
  })

  test('a forged cursor is refused', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 4)
    const first = await gm.verdict('?limit=2')
    if (!('partial' in first)) {
      throw new Error('expected a partial verdict')
    }
    const [seq, mac] = first.cursor.split('.')
    const forged = `${Number(seq) + 2}.${mac}.${'0'.repeat(64)}`
    const res = await gm.verify(`?limit=2&cursor=${encodeURIComponent(forged)}`)
    expect(res.status).toBe(400)
  })

  test('verify starts from the latest checkpoint unless a full replay is asked for', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 4)
    await gm.checkpoint()
    // An event edited behind the checkpoint, without touching the chain.
    await tamper(
      () =>
        harness.owner`update events set payload = '{"forged":true}'::jsonb where guild_id = ${gm.id} and seq = 2`
    )
    expect(await gm.verdict()).toMatchObject({ intact: true })
    expect(await gm.verdict('?full=true')).toMatchObject({ intact: false, firstBadSeq: 2 })
  })

  test('a checkpoint signed under a bounded limit covers only what was verified', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 9)
    const cp = Checkpoint.parse((await gm.checkpoint({ limit: 3 })).body)
    expect(cp.complete).toBe(false)
    expect(cp.seq).toBe(3)
  })

  test('the verify transaction runs under a statement timeout', async () => {
    const [row] = await harness.owner`select 1`
    expect(row).toBeDefined()
    const gm = await guildMaster()
    const seen = await db.withGuild(gm.id, async (tx) => {
      await bindVerifyTimeout(tx)
      const [r] = await tx`select current_setting('statement_timeout') as t`
      return String(r?.t)
    })
    expect(seen).not.toBe('0')
  })
})

describe('audit_checkpoints tenancy', () => {
  test("another guild's context sees and writes none of this guild's checkpoints", async () => {
    const a = await guildMaster()
    const b = await guildMaster()
    await a.checkpoint()
    const seen = await db.withGuild(
      b.id,
      (tx) => tx`select seq from audit_checkpoints where guild_id = ${a.id}`
    )
    expect(seen.length).toBe(0)
    const forged = await db
      .withGuild(
        b.id,
        (tx) => tx`insert into audit_checkpoints (guild_id, seq, mac, signature)
        values (${a.id}, 99, ${'0'.repeat(64)}, ${'0'.repeat(64)})`
      )
      .then(
        () => 'ok',
        () => 'denied'
      )
    expect(forged).toBe('denied')
  })

  test("a session cannot sign another guild's checkpoint", async () => {
    const a = await guildMaster()
    const b = await guildMaster()
    const res = await post(
      `/guilds/${b.id}/audit/checkpoints`,
      {},
      {
        ...a.auth,
        'x-reauth-proof': 'x',
      }
    )
    expect([403, 404]).toContain(res.status)
    expect(await anchor.latest(b.id)).toBeNull()
  })
})
