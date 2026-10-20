import { expect, test } from 'bun:test'
import { MemoryIdentityStore } from './memory-identity-provider'

test('two same-tick founding finishes with one token register exactly one passkey', async () => {
  const store = new MemoryIdentityStore()
  const guild = crypto.randomUUID()
  const now = new Date('2026-01-01T00:00:00.000Z')
  await store.issueFounding(guild, 'hash', new Date(now.getTime() + 60_000), {
    type: 'identity.founding_token_issued',
    payload: {},
  })
  const credential = (id: string) => ({
    id,
    publicKey: new Uint8Array(4),
    counter: 0,
    transports: [],
  })
  const results = await Promise.all([
    store.foundCredential(guild, credential('a'), 'hash', now, []),
    store.foundCredential(guild, credential('b'), 'hash', now, []),
  ])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(await store.listCredentials(guild)).toHaveLength(1)
})

test('setReauth for an unknown session appends no event', async () => {
  const store = new MemoryIdentityStore()
  const guild = crypto.randomUUID()
  await expect(
    store.setReauth(guild, crypto.randomUUID(), 'rh', new Date(), {
      type: 'identity.reauthenticated',
      payload: {},
    })
  ).rejects.toThrow()
  expect(store.eventsOf(guild)).toHaveLength(0)
})

test('same-tick founding finishes append exactly one event pair', async () => {
  const store = new MemoryIdentityStore()
  const guild = crypto.randomUUID()
  const now = new Date('2026-01-01T00:00:00.000Z')
  await store.issueFounding(guild, 'hash', new Date(now.getTime() + 60_000), {
    type: 'identity.founding_token_issued',
    payload: {},
  })
  const credential = (id: string) => ({
    id,
    publicKey: new Uint8Array(4),
    counter: 0,
    transports: [],
  })
  const pair = (id: string) => [
    { type: 'identity.founding_token_spent', payload: { credentialId: id } },
    { type: 'identity.passkey_registered', payload: { credentialId: id } },
  ]
  await Promise.all([
    store.foundCredential(guild, credential('a'), 'hash', now, pair('a')),
    store.foundCredential(guild, credential('b'), 'hash', now, pair('b')),
  ])
  expect(store.eventsOf(guild)).toHaveLength(3)
})
