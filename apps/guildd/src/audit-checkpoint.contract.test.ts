import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryCheckpointAnchor } from './adapters/memory-checkpoint-anchor'
import { bindVerifyTimeout, checkpointHash, checkpointSignature } from './audit-chain'
import { appendEvent } from './events'
import type { AnchoredCheckpoint, CheckpointAnchor } from './ports/checkpoint-anchor'
import { foundViaApi } from './testing/found-via-api'
import { createHarness } from './testing/harness'

/** An anchor whose custody can be swapped under the app, to simulate a wiped or corrupt one. */
class SwitchableAnchor implements CheckpointAnchor {
  constructor(public inner: CheckpointAnchor) {}
  publish(guildId: string, checkpoint: AnchoredCheckpoint) {
    return this.inner.publish(guildId, checkpoint)
  }
  latest(guildId: string) {
    return this.inner.latest(guildId)
  }
}

const switchable = new SwitchableAnchor(new MemoryCheckpointAnchor())
const harness = await createHarness({ devGuildHeader: false, app: { anchor: switchable } })
const timed = await createHarness({
  devGuildHeader: false,
  now: new Date(),
  app: { anchor: new MemoryCheckpointAnchor() },
})
afterAll(async () => {
  await harness.close()
  await timed.close()
})
const { db, keys } = harness.adapters

type Harness = typeof harness

const json = { 'content-type': 'application/json' }
const ceremony = z.object({
  challengeId: z.string(),
  options: z.object({ challenge: z.string() }),
})
const tokenBody = z.object({ token: z.string() })
const status = { lastCheckpointAt: z.string().nullable(), overdue: z.boolean() }
const Verdict = z.union([
  z.object({ intact: z.literal(true), entries: z.number(), ...status }),
  z.object({
    intact: z.literal(true),
    partial: z.literal(true),
    verifiedThrough: z.number(),
    cursor: z.string(),
    ...status,
  }),
  z.object({ intact: z.literal(false), firstBadSeq: z.number(), reason: z.string() }),
])
const Begun = ceremony.extend({ seq: z.number(), mac: z.string(), complete: z.boolean() })
const Checkpoint = z.object({
  seq: z.number(),
  mac: z.string(),
  signature: z.string(),
  complete: z.boolean(),
})

async function guildMaster(h: Harness = harness) {
  const post = (path: string, body: unknown, headers = {}) =>
    h.request(path, {
      method: 'POST',
      headers: { ...json, ...headers },
      body: JSON.stringify(body),
    })
  const f = await foundViaApi(h, { name: 'Audit', goal: 'g' })
  const id = f.id
  const key = f.key
  let auth = { authorization: 'Bearer ' }
  async function signIn() {
    const begin = ceremony.parse(await (await post(`/guilds/${id}/sign-in/begin`, {})).json())
    const res = await post(`/guilds/${id}/sign-in/finish`, {
      challengeId: begin.challengeId,
      response: await key.assert(begin.options),
    })
    auth = { authorization: `Bearer ${tokenBody.parse(await res.json()).token}` }
  }
  await signIn()
  const gm = {
    id,
    key,
    signIn,
    post,
    get auth() {
      return auth
    },
    async verify(query = '') {
      const res = await h.request(`/guilds/${id}/audit/verify${query}`, { headers: auth })
      return { status: res.status, body: await res.json() }
    },
    async verdict(query = '') {
      return Verdict.parse((await gm.verify(query)).body)
    },
    async begin(body: unknown = {}) {
      return post(`/guilds/${id}/audit/checkpoints/begin`, body, auth)
    },
    /** The Guild Master's passkey ceremony over the day's checkpoint. */
    async checkpoint(limit?: number) {
      const limitPart = limit === undefined ? {} : { limit }
      const begun = Begun.parse(await (await gm.begin(limitPart)).json())
      const res = await post(
        `/guilds/${id}/audit/checkpoints/finish`,
        {
          challengeId: begun.challengeId,
          response: await key.assert(begun.options),
          seq: begun.seq,
          mac: begun.mac,
          ...limitPart,
        },
        auth
      )
      return { status: res.status, body: await res.json(), begun }
    },
  }
  return gm
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
  await o`alter table audit_checkpoints disable trigger user`
  try {
    await run()
  } finally {
    await o`alter table audit_chain enable trigger user`
    await o`alter table events enable trigger user`
    await o`alter table audit_checkpoints enable trigger user`
  }
}

describe('audit checkpoint ceremony', () => {
  test('beginning needs a session', async () => {
    const gm = await guildMaster()
    const res = await harness.request(`/guilds/${gm.id}/audit/checkpoints/begin`, {
      method: 'POST',
      headers: json,
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  test("a session cannot sign another guild's checkpoint", async () => {
    const a = await guildMaster()
    const b = await guildMaster()
    const res = await a.post(`/guilds/${b.id}/audit/checkpoints/begin`, {}, a.auth)
    expect(res.status).toBe(404)
    expect(await switchable.latest(b.id)).toBeNull()
  })

  test('the Guild Master signs the head with the passkey; it is anchored, recorded and verifies', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 2)
    const { status: code, body, begun } = await gm.checkpoint()
    expect(code).toBe(201)
    const cp = Checkpoint.parse(body)
    expect(cp).toMatchObject({ seq: begun.seq, mac: begun.mac, complete: true })
    const [head] = await harness.owner`
      select seq, mac from audit_chain where guild_id = ${gm.id} order by seq desc limit 1`
    expect(cp).toMatchObject({ seq: Number(head?.seq), mac: head?.mac })
    expect(cp.signature).toBe(await checkpointSignature(keys, gm.id, cp.seq, cp.mac))
    expect(await switchable.latest(gm.id)).toEqual({
      seq: cp.seq,
      mac: cp.mac,
      signature: cp.signature,
    })
    const [row] = await harness.owner`
      select credential_id, signature from audit_checkpoints where guild_id = ${gm.id}`
    expect(row?.credential_id).toBe(Buffer.from(gm.key.credentialId).toString('base64url'))
    expect(await gm.verdict()).toMatchObject({ intact: true })
  })

  test('the passkey challenge carries the checkpoint hash', async () => {
    const gm = await guildMaster()
    const begun = Begun.parse(await (await gm.begin()).json())
    const bytes = Buffer.from(begun.options.challenge, 'base64url')
    expect(bytes.subarray(0, 32).toString('hex')).toBe(checkpointHash(gm.id, begun.seq, begun.mac))
  })

  test('a malformed finish is refused before the challenge is spent', async () => {
    const gm = await guildMaster()
    const begun = Begun.parse(await (await gm.begin()).json())
    const bad = await gm.post(
      `/guilds/${gm.id}/audit/checkpoints/finish`,
      { challengeId: begun.challengeId },
      gm.auth
    )
    expect(bad.status).toBe(400)
    const ok = await gm.post(
      `/guilds/${gm.id}/audit/checkpoints/finish`,
      {
        challengeId: begun.challengeId,
        response: await gm.key.assert(begun.options),
        seq: begun.seq,
        mac: begun.mac,
      },
      gm.auth
    )
    expect(ok.status).toBe(201)
  })

  test('a finish naming a different position than the passkey signed is refused', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 2)
    const begun = Begun.parse(await (await gm.begin()).json())
    const res = await gm.post(
      `/guilds/${gm.id}/audit/checkpoints/finish`,
      {
        challengeId: begun.challengeId,
        response: await gm.key.assert(begun.options),
        seq: begun.seq - 1,
        mac: 'a'.repeat(64),
      },
      gm.auth
    )
    expect(res.status).toBe(409)
    expect(await switchable.latest(gm.id)).toBeNull()
  })

  test('signing again with nothing new is idempotent', async () => {
    const gm = await guildMaster()
    const first = Checkpoint.parse((await gm.checkpoint()).body)
    const second = Checkpoint.parse((await gm.checkpoint()).body)
    expect(second).toEqual(first)
    const rows = await harness.owner`select 1 from audit_checkpoints where guild_id = ${gm.id}`
    expect(rows.length).toBe(1)
  })
})

describe('the stored passkey assertion is re-verified', () => {
  test('an absent assertion fails verify', async () => {
    const gm = await guildMaster()
    await gm.checkpoint()
    await tamper(
      () =>
        harness.owner`update audit_checkpoints set credential_id = null, authenticator_data = null,
          client_data_json = null, assertion_signature = null where guild_id = ${gm.id}`
    )
    expect(await gm.verdict()).toMatchObject({
      intact: false,
      reason: expect.stringContaining('assertion'),
    })
  })

  test('a wrong assertion signature fails verify', async () => {
    const gm = await guildMaster()
    await gm.checkpoint()
    const [row] = await harness.owner`
      select assertion_signature as s from audit_checkpoints where guild_id = ${gm.id}`
    const flipped = `${String(row?.s).startsWith('A') ? 'B' : 'A'}${String(row?.s).slice(1)}`
    await tamper(
      () =>
        harness.owner`update audit_checkpoints set assertion_signature = ${flipped} where guild_id = ${gm.id}`
    )
    expect(await gm.verdict()).toMatchObject({ intact: false })
  })

  test("an assertion from another guild's credential fails verify", async () => {
    const a = await guildMaster()
    const b = await guildMaster()
    await a.checkpoint()
    const begun = Begun.parse(await (await a.begin()).json())
    const forged = await b.key.assert(begun.options)
    await tamper(
      () =>
        harness.owner`update audit_checkpoints set credential_id = ${forged.id},
          authenticator_data = ${forged.response.authenticatorData},
          client_data_json = ${forged.response.clientDataJSON},
          assertion_signature = ${forged.response.signature} where guild_id = ${a.id}`
    )
    expect(await a.verdict()).toMatchObject({ intact: false })
  })

  test('an assertion over a different checkpoint fails verify', async () => {
    const gm = await guildMaster()
    await gm.checkpoint()
    await grow(gm.id, 1)
    const second = await gm.checkpoint()
    const [first] = await harness.owner`
      select seq from audit_checkpoints where guild_id = ${gm.id} order by seq limit 1`
    const [latest] = await harness.owner`
      select credential_id, authenticator_data, client_data_json, assertion_signature
      from audit_checkpoints where guild_id = ${gm.id} order by seq desc limit 1`
    expect(Number(first?.seq)).toBeLessThan(Checkpoint.parse(second.body).seq)
    // Move the newest assertion onto the older row, then drop the newest row: the old checkpoint
    // now carries a passkey signature over some other position.
    await tamper(async () => {
      await harness.owner`update audit_checkpoints set credential_id = ${latest?.credential_id},
        authenticator_data = ${latest?.authenticator_data}, client_data_json = ${latest?.client_data_json},
        assertion_signature = ${latest?.assertion_signature}
        where guild_id = ${gm.id} and seq = ${first?.seq}`
      await harness.owner`delete from audit_checkpoints where guild_id = ${gm.id} and seq > ${first?.seq}`
    })
    expect(await gm.verdict()).toMatchObject({ intact: false })
  })
})

describe('truncation of the chain tail', () => {
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
      await harness.owner`delete from audit_checkpoints where guild_id = ${gm.id}`
      await harness.owner`delete from audit_chain where guild_id = ${gm.id} and seq = ${cp.seq}`
      await harness.owner`delete from events where guild_id = ${gm.id} and seq = ${cp.seq}`
    })
    expect(await gm.verdict()).toMatchObject({ intact: false, firstBadSeq: cp.seq })
  })

  test('a forged anchor entry (wrong signature) fails verify', async () => {
    const gm = await guildMaster()
    await switchable.publish(gm.id, { seq: 99, mac: 'f'.repeat(64), signature: '0'.repeat(64) })
    expect(await gm.verdict()).toMatchObject({
      intact: false,
      reason: expect.stringContaining('signature'),
    })
  })

  test('a missing or fresh anchor does not hide the truncation', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 2)
    const cp = Checkpoint.parse((await gm.checkpoint()).body)
    const real = switchable.inner
    switchable.inner = new MemoryCheckpointAnchor()
    try {
      expect(await gm.verdict()).toMatchObject({
        intact: false,
        reason: 'anchor missing or behind',
      })
      await tamper(async () => {
        await harness.owner`delete from audit_chain where guild_id = ${gm.id} and seq = ${cp.seq}`
        await harness.owner`delete from events where guild_id = ${gm.id} and seq = ${cp.seq}`
      })
      expect(await gm.verdict()).toMatchObject({ intact: false })
    } finally {
      switchable.inner = real
    }
  })

  test('an anchor behind the stored checkpoint fails verify', async () => {
    const gm = await guildMaster()
    const first = Checkpoint.parse((await gm.checkpoint()).body)
    await grow(gm.id, 1)
    await gm.checkpoint()
    const real = switchable.inner
    const stale = new MemoryCheckpointAnchor()
    await stale.publish(gm.id, {
      seq: first.seq,
      mac: first.mac,
      signature: first.signature,
    })
    switchable.inner = stale
    try {
      expect(await gm.verdict()).toMatchObject({
        intact: false,
        reason: 'anchor missing or behind',
      })
    } finally {
      switchable.inner = real
    }
  })

  test('a corrupt anchor reports unreadable rather than failing the request', async () => {
    const gm = await guildMaster()
    await gm.checkpoint()
    const real = switchable.inner
    switchable.inner = {
      publish: async () => {},
      latest: async () => {
        throw new Error('garbled')
      },
    }
    try {
      const res = await gm.verify()
      expect(res.status).toBe(200)
      expect(Verdict.parse(res.body)).toMatchObject({ intact: false, reason: 'anchor unreadable' })
    } finally {
      switchable.inner = real
    }
  })
})

describe('the daily signature', () => {
  const DAY = 24 * 60 * 60 * 1000

  test('a missing or stale signature is overdue, and a new checkpoint clears it', async () => {
    const gm = await guildMaster(timed)
    const clock = timed.adapters.clock
    expect(await gm.verdict()).toMatchObject({
      intact: true,
      lastCheckpointAt: null,
      overdue: false,
    })
    clock.advance(DAY + 60_000)
    await gm.signIn()
    expect(await gm.verdict()).toMatchObject({ lastCheckpointAt: null, overdue: true })
    await gm.checkpoint()
    expect(await gm.verdict()).toMatchObject({
      lastCheckpointAt: clock.now().toISOString(),
      overdue: false,
    })
    clock.advance(DAY + 60_000)
    await gm.signIn()
    expect(await gm.verdict()).toMatchObject({ overdue: true })
    await gm.checkpoint()
    expect(await gm.verdict()).toMatchObject({ overdue: false })
  })
})

describe('the daily signature on a harness clock far from database time', () => {
  test('a guild with no checkpoint is overdue 25 hours later, on the default clock', async () => {
    const h = await createHarness({ devGuildHeader: false })
    try {
      const gm = await guildMaster(h)
      h.adapters.clock.advance(25 * 60 * 60 * 1000)
      await gm.signIn()
      expect(await gm.verdict()).toMatchObject({ lastCheckpointAt: null, overdue: true })
    } finally {
      await h.close()
    }
  })
})

describe('bounded, resumable verification', () => {
  async function resume(gm: Awaited<ReturnType<typeof guildMaster>>, limit: number) {
    let verdict = await gm.verdict(`?limit=${limit}`)
    const pages: number[] = []
    while ('partial' in verdict) {
      pages.push(verdict.verifiedThrough)
      verdict = await gm.verdict(`?limit=${limit}&cursor=${encodeURIComponent(verdict.cursor)}`)
    }
    return { verdict, pages }
  }

  test('a chain larger than the limit returns a cursor, and resuming finishes intact', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 9)
    const [{ n } = { n: 0 }] =
      await harness.owner`select count(*)::int as n from audit_chain where guild_id = ${gm.id}`
    const { verdict, pages } = await resume(gm, 3)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages).toEqual([...pages].sort((a, b) => a - b))
    expect(verdict).toMatchObject({ intact: true, entries: n })
  })

  test('tampering past the first page is found when resuming', async () => {
    const gm = await guildMaster()
    await grow(gm.id, 9)
    await tamper(
      () =>
        harness.owner`update audit_chain set mac = ${'a'.repeat(64)} where guild_id = ${gm.id} and seq = 8`
    )
    expect((await resume(gm, 3)).verdict).toMatchObject({ intact: false, firstBadSeq: 8 })
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

  test('resuming after the entry at the cursor was altered or deleted fails', async () => {
    for (const change of ['alter', 'delete'] as const) {
      const gm = await guildMaster()
      await grow(gm.id, 6)
      const first = await gm.verdict('?limit=2')
      if (!('partial' in first)) {
        throw new Error('expected a partial verdict')
      }
      await tamper(async () => {
        if (change === 'alter') {
          await harness.owner`update audit_chain set mac = ${'c'.repeat(64)}
            where guild_id = ${gm.id} and seq = ${first.verifiedThrough}`
        } else {
          await harness.owner`delete from audit_chain
            where guild_id = ${gm.id} and seq = ${first.verifiedThrough}`
        }
      })
      const resumed = await gm.verdict(`?limit=2&cursor=${encodeURIComponent(first.cursor)}`)
      expect(resumed).toMatchObject({ intact: false })
    }
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
    const cp = Checkpoint.parse((await gm.checkpoint(3)).body)
    expect(cp.complete).toBe(false)
    expect(cp.seq).toBe(3)
  })

  test('the verify transaction runs under a statement timeout', async () => {
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
})
