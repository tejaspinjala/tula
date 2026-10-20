import { describe, expect, test } from 'bun:test'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { mintToken, verifyToken } from './tokens'

const keys = new MemoryKeyProvider()
const G = crypto.randomUUID()
const Q = crypto.randomUUID()
const lease = { k: 'lease', g: G, q: Q, a: 1, m: 'heralds-member-2' } as const

describe('MCP tokens', () => {
  test('a minted token verifies and yields its claims, guild included', async () => {
    const token = await mintToken(keys, lease)
    expect(await verifyToken(keys, token)).toEqual(lease)
  })

  test('a token with altered claims, a foreign MAC or garbage is refused', async () => {
    const token = await mintToken(keys, lease)
    const [payload = '', mac = ''] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...lease, a: 2 })).toString('base64url')
    const otherGuild = Buffer.from(JSON.stringify({ ...lease, g: crypto.randomUUID() })).toString(
      'base64url'
    )
    for (const bad of [
      `${forged}.${mac}`,
      `${otherGuild}.${mac}`,
      `${payload}.${'0'.repeat(64)}`,
    ]) {
      expect(await verifyToken(keys, bad)).toBeNull()
    }
    for (const junk of ['', 'a.b', '.', 'not-a-token', `${payload}`, `${payload}.${mac}.x`]) {
      expect(await verifyToken(keys, junk)).toBeNull()
    }
  })

  test('a token minted under another key custody is refused', async () => {
    const token = await mintToken(new MemoryKeyProvider(), lease)
    expect(await verifyToken(keys, token)).toBeNull()
  })
})
