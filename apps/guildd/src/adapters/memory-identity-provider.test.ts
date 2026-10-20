import { identityContract } from '../ports/identity.contract'
import { MemoryClock } from './memory-clock'
import { MemoryIdentityProvider } from './memory-identity-provider'

identityContract('memory', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  const origin = 'http://localhost:5173'
  return {
    identity: new MemoryIdentityProvider({ clock, rpId: 'localhost', rpName: 'Guildhall', origin }),
    clock,
    newGuild: async () => crypto.randomUUID(),
    rpId: 'localhost',
    origin,
  }
})
