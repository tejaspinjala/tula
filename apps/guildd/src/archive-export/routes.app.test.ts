import { afterAll, describe, expect, test } from 'bun:test'
import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'
import { eventsAfter } from '../events'
import { createHarness } from '../testing/harness'
import { SoftwareAuthenticator } from '../testing/software-authenticator'
import { ARCHIVE_EVENT } from './events'

const harness = await createHarness({ devGuildHeader: true })
afterAll(async () => {
  await harness.close()
})

const ORIGIN = 'http://localhost:5173'

/** A founded guild with a signed-in Guild Master session, through the real identity adapter. */
async function signedIn(name: string) {
  const guildId = await harness.foundGuild({ name, goal: 'g' })
  await harness.adapters.config.seed(guildId)
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const identity = harness.adapters.identity
  const founding = await identity.issueFoundingToken(guildId)
  const reg = await identity.beginRegistration(guildId, { foundingToken: founding.token })
  await identity.finishRegistration(guildId, reg.challengeId, await key.register(reg.options))
  const sign = await identity.beginSignIn(guildId)
  const { token } = await identity.finishSignIn(
    guildId,
    sign.challengeId,
    await key.assert(sign.options)
  )
  const reauth = async () => {
    const begin = await identity.beginReauth(token)
    const proof = await identity.finishReauth(
      token,
      begin.challengeId,
      await key.assert(begin.options)
    )
    return { authorization: `Bearer ${token}`, 'x-reauth-proof': proof.proof }
  }
  return { guildId, auth: { authorization: `Bearer ${token}` }, reauth }
}

const exported = (guildId: string) =>
  harness.adapters.db.withGuild(guildId, async (tx) =>
    (await eventsAfter(tx, 0, 1000)).filter((e) => e.type === ARCHIVE_EVENT.exported)
  )

const url = (guildId: string, query = '') => `/guilds/${guildId}/archive/export${query}`

describe('GET /guilds/:id/archive/export through the composed app', () => {
  test('the signed-in Guild Master exports; the private note needs a fresh passkey proof', async () => {
    const a = await signedIn('Guild A')
    const fact = { kind: 'text', claim: 'fact', evidence: 'seen' } as const
    await harness.adapters.notes.add(a.guildId, { ...fact, title: 'Open', body: 'plain' })
    await harness.adapters.notes.add(
      a.guildId,
      { ...fact, title: 'Hidden', body: 'secret body' },
      undefined,
      undefined,
      'private'
    )
    const plain = await harness.request(url(a.guildId), { headers: a.auth })
    expect(plain.status).toBe(200)
    expect(Object.keys(unzipSync(new Uint8Array(await plain.arrayBuffer())))).not.toContain(
      'Private/Guild Master/Hidden.md'
    )
    expect(await exported(a.guildId)).toHaveLength(1)

    const noProof = await harness.request(url(a.guildId, '?private=true'), { headers: a.auth })
    expect(noProof.status).toBe(403)
    expect(await exported(a.guildId)).toHaveLength(1)

    const proven = await harness.request(url(a.guildId, '?private=true'), {
      headers: await a.reauth(),
    })
    expect(proven.status).toBe(200)
    const files = unzipSync(new Uint8Array(await proven.arrayBuffer()))
    expect(strFromU8(files['Private/Guild Master/Hidden.md'] ?? new Uint8Array())).toContain(
      'secret body'
    )
    expect(await exported(a.guildId)).toHaveLength(2)
  })

  test('anonymous, dev-header-only and bogus-token requests are 401 with no event', async () => {
    const a = await signedIn('Guild A')
    for (const headers of [
      {},
      { 'x-guild-id': a.guildId },
      { authorization: 'Bearer not-a-session' },
    ]) {
      expect((await harness.request(url(a.guildId), { headers })).status).toBe(401)
    }
    expect(await exported(a.guildId)).toHaveLength(0)
  })

  test('the Guild Master of A aiming at B is refused as at a missing guild and B is untouched', async () => {
    const a = await signedIn('Guild A')
    const b = await signedIn('Guild B-secret')
    const atB = await harness.request(url(b.guildId), { headers: a.auth })
    const atGhost = await harness.request(url(crypto.randomUUID()), { headers: a.auth })
    const body = await atB.text()
    expect(atB.status).toBe(404)
    expect(atGhost.status).toBe(404)
    expect(body).not.toContain('B-secret')
    expect(z.object({ error: z.string() }).parse(JSON.parse(body)).error).toBe('not_found')
    expect(await exported(b.guildId)).toHaveLength(0)
  })
})
