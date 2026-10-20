import { expect, test } from 'bun:test'
import { MemoryIdentityStore } from './memory-identity-provider'

test('two same-tick founding finishes with one token register exactly one passkey', async () => {
  const store = new MemoryIdentityStore()
  const guild = crypto.randomUUID()
  const now = new Date('2026-01-01T00:00:00.000Z')
  await store.issueFounding(guild, 'hash', new Date(now.getTime() + 60_000))
  const credential = (id: string) => ({
    id,
    publicKey: new Uint8Array(4),
    counter: 0,
    transports: [],
  })
  const results = await Promise.all([
    store.foundCredential(guild, credential('a'), 'hash', now),
    store.foundCredential(guild, credential('b'), 'hash', now),
  ])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(await store.listCredentials(guild)).toHaveLength(1)
})
