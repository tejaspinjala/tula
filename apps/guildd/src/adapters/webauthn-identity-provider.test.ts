import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { identityContract } from '../ports/identity.contract'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { PgIdentityStore } from './pg-identity-store'
import { WebAuthnIdentityProvider } from './webauthn-identity-provider'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

identityContract('embedded WebAuthn (Postgres)', async () => {
  const clock = new MemoryClock(new Date())
  const origin = 'http://localhost:5173'
  return {
    identity: new WebAuthnIdentityProvider(new PgIdentityStore(db), {
      clock,
      rpId: 'localhost',
      rpName: 'Guildhall',
      origin,
    }),
    clock,
    newGuild: () => db.foundGuild({ name: 'Identity', goal: 'Sign in' }),
    rpId: 'localhost',
    origin,
  }
})
