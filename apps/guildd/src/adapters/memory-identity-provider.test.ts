import { identityContract } from '../ports/identity.contract'
import { MemoryClock } from './memory-clock'
import { MemoryIdentityStore } from './memory-identity-provider'
import { WebAuthnIdentityProvider } from './webauthn-identity-provider'

identityContract('memory', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  const origin = 'http://localhost:5173'
  const store = new MemoryIdentityStore()
  return {
    identity: new WebAuthnIdentityProvider(store, {
      clock,
      rpId: 'localhost',
      rpName: 'Guildhall',
      origin,
    }),
    clock,
    newGuild: async () => crypto.randomUUID(),
    events: async (guildId: string) => store.eventsOf(guildId),
    rpId: 'localhost',
    origin,
  }
})
