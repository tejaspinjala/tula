import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemorySealStore } from './adapters/memory-seal-store'
import { hashProposal, SEAL_TTL_MS } from './ports/seal-store'
import { GUILD_MASTER_ID, SealEngine } from './seals'

async function engine() {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  const seals = new SealEngine({ store: new MemorySealStore(clock), config })
  return { seals, guild, clock, config }
}

const proposal = { questId: crypto.randomUUID(), requestedBy: 'herald-1', kind: 'post' }
const master = { role: 'guild_master', id: GUILD_MASTER_ID } as const

describe('SealEngine', () => {
  test('requestSeal binds the Seal to the hash of the exact text', async () => {
    const { seals, guild } = await engine()
    const seal = await seals.requestSeal(guild, { ...proposal, text: 'hello', evidence: 'pass' })
    expect(seal.actionHash).toBe(await hashProposal('hello'))
    expect(seal.status).toBe('requested')
  })

  test('every external action needs a Seal under the always policy; an unseeded guild has no policy', async () => {
    const { seals } = await engine()
    await expect(
      seals.requestSeal(crypto.randomUUID(), { ...proposal, text: 'x', evidence: 'e' })
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  test('a requester using the Guild Master id is refused at requestSeal', async () => {
    const { seals, guild } = await engine()
    for (const requestedBy of [GUILD_MASTER_ID, ` ${GUILD_MASTER_ID.toUpperCase()} `]) {
      await expect(
        seals.requestSeal(guild, { ...proposal, requestedBy, text: 'x', evidence: 'e' })
      ).rejects.toMatchObject({ code: 'requester_reserved' })
    }
  })

  test('a distinct agent requester can be approved by the Guild Master', async () => {
    const { seals, guild } = await engine()
    const seal = await seals.requestSeal(guild, { ...proposal, text: 'hello', evidence: 'pass' })
    expect(
      await seals.decide(
        guild,
        seal.id,
        { verdict: 'approved', expectedHash: seal.actionHash },
        master
      )
    ).toMatchObject({ ok: true })
  })

  test('only the Guild Master decides; the requester and other agents are ignored', async () => {
    const { seals, guild } = await engine()
    const seal = await seals.requestSeal(guild, { ...proposal, text: 'hello', evidence: 'pass' })
    const input = { verdict: 'approved', expectedHash: seal.actionHash } as const
    for (const who of [
      { role: 'agent', id: 'herald-1' },
      { role: 'agent', id: 'steward' },
      { role: 'guild_master', id: 'herald-1' },
    ] as const) {
      expect(await seals.decide(guild, seal.id, input, who)).toEqual({
        ok: false,
        reason: 'not_authorised',
      })
    }
    expect((await seals.get(guild, seal.id))?.status).toBe('requested')
    expect(await seals.decide(guild, seal.id, input, master)).toMatchObject({ ok: true })
  })

  test('approval of one hash cannot authorise a different payload', async () => {
    const { seals, guild } = await engine()
    const seal = await seals.requestSeal(guild, { ...proposal, text: 'hello', evidence: 'pass' })
    const other = await hashProposal('hello, but different')
    expect(
      await seals.decide(guild, seal.id, { verdict: 'approved', expectedHash: other }, master)
    ).toEqual({ ok: false, reason: 'hash_mismatch' })
    await seals.decide(
      guild,
      seal.id,
      { verdict: 'approved', expectedHash: seal.actionHash },
      master
    )
    expect(await seals.reserve(guild, seal.id, 'hello, but different')).toEqual({
      ok: false,
      reason: 'hash_mismatch',
    })
    expect(await seals.markPosted(guild, seal.id, 'hello, but different')).toEqual({
      ok: false,
      reason: 'hash_mismatch',
    })
  })

  test('an unanswered Seal expires after 72 hours', async () => {
    const { seals, guild, clock } = await engine()
    const seal = await seals.requestSeal(guild, { ...proposal, text: 'hello', evidence: 'pass' })
    clock.advance(SEAL_TTL_MS)
    expect(
      await seals.decide(
        guild,
        seal.id,
        { verdict: 'approved', expectedHash: seal.actionHash },
        master
      )
    ).toEqual({ ok: false, reason: 'expired' })
  })
})
