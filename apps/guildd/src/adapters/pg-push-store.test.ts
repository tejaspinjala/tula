import { afterAll, describe, expect, test } from 'bun:test'
import { createDb, type Db } from '../db/client'
import { pushStoreContract } from '../ports/push-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { PgPushStore } from './pg-push-store'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

pushStoreContract('postgres', async () => ({
  store: new PgPushStore(db),
  newGuild: () => foundTestGuild(db, { name: 'Push', goal: 'g' }),
}))

describe('PgPushStore registry', () => {
  test('a subscription and its registry row commit together, so a restart sweep cannot miss it', async () => {
    const guild = await foundTestGuild(db, { name: 'Registry', goal: 'g' })
    // Fault injection: every statement that touches the registry fails inside the transaction.
    const failing: Db = {
      ...db,
      withGuild: (guildId, fn) =>
        db.withGuild(guildId, (tx) =>
          fn(
            new Proxy(tx, {
              apply(target, thisArg, args) {
                if (String(args[0]).includes('push_guilds')) {
                  throw new Error('registry down')
                }
                return Reflect.apply(target, thisArg, args)
              },
            })
          )
        ),
    }
    const device = { endpoint: 'https://push.example/reg', p256dh: 'k', auth: 'a' }
    await expect(
      new PgPushStore(failing).add(guild, crypto.randomUUID(), device, 0)
    ).rejects.toThrow()
    expect((await new PgPushStore(db).list(guild, { limit: 10 })).subscriptions).toEqual([])
    await new PgPushStore(db).add(guild, crypto.randomUUID(), device, 0)
    expect(await new PgPushStore(db).guildsWithDevices(undefined, 1000)).toContain(guild)
  })
})
