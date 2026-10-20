import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryIdentityProvider } from './adapters/memory-identity-provider'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { enrolLink, parseEnrolArgs } from './enrol-link'

function identity() {
  return new MemoryIdentityProvider({
    clock: new MemoryClock(new Date('2026-01-01T00:00:00.000Z')),
    keys: new MemoryKeyProvider(),
    rpId: 'localhost',
    rpName: 'Guildhall',
    origin: 'https://hall.example',
  })
}

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('guild:enrol-link', () => {
  test('parses --guild and rejects anything else', () => {
    expect(parseEnrolArgs(['--guild', A])).toEqual({ guild: A })
    expect(parseEnrolArgs([])).toEqual({})
    expect(() => parseEnrolArgs(['--guild'])).toThrow()
    expect(() => parseEnrolArgs(['--guild', 'nope'])).toThrow()
    expect(() => parseEnrolArgs(['--wat'])).toThrow()
  })

  test('prints origin plus a fragment carrying the token, never a query string', async () => {
    const link = await enrolLink({
      identity: identity(),
      origin: 'https://hall.example',
      guildIds: async () => [A],
      args: {},
    })
    const url = new URL(link.url)
    expect(url.origin).toBe('https://hall.example')
    expect(url.search).toBe('')
    expect(url.hash.startsWith('#enrol=')).toBe(true)
    expect(url.hash.slice('#enrol='.length).startsWith(`${A}.`)).toBe(true)
    expect(link.guildId).toBe(A)
  })

  test('with several guilds it needs --guild, with none it says so', async () => {
    const base = { identity: identity(), origin: 'https://hall.example' }
    await expect(enrolLink({ ...base, guildIds: async () => [A, B], args: {} })).rejects.toThrow(
      /--guild/
    )
    await expect(enrolLink({ ...base, guildIds: async () => [], args: {} })).rejects.toThrow(
      /no guild/i
    )
    const link = await enrolLink({ ...base, guildIds: async () => [A, B], args: { guild: B } })
    expect(link.guildId).toBe(B)
    await expect(
      enrolLink({ ...base, guildIds: async () => [A], args: { guild: B } })
    ).rejects.toThrow(/no such guild/i)
  })
})
