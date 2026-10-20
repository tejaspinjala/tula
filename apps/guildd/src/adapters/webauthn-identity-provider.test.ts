import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { eventsAfter } from '../events'
import { identityContract } from '../ports/identity.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgIdentityStore } from './pg-identity-store'
import { WebAuthnIdentityProvider } from './webauthn-identity-provider'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

identityContract('embedded WebAuthn (Postgres)', async () => {
  const clock = new MemoryClock(new Date())
  const origin = 'http://localhost:5173'
  const keys = new MemoryKeyProvider()
  return {
    identity: new WebAuthnIdentityProvider(new PgIdentityStore(db, keys), {
      clock,
      keys,
      rpId: 'localhost',
      rpName: 'Guildhall',
      origin,
    }),
    clock,
    newGuild: () => foundTestGuild(db, { name: 'Identity', goal: 'Sign in' }),
    events: (guildId: string) => db.withGuild(guildId, (tx) => eventsAfter(tx, 0)),
    rpId: 'localhost',
    origin,
  }
})
