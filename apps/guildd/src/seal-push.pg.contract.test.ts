import { afterAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { z } from 'zod'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryPushNotifier } from './adapters/memory-push-notifier'
import { PgPushStore } from './adapters/pg-push-store'
import { createDb } from './db/client'
import type { PushNotifier, PushPayload } from './ports/push-notifier'
import type { PushSubscription } from './ports/push-store'
import { createSealPushRelay } from './seal-push'
import { createHarness } from './testing/harness'
import { testDbUrl } from './testing/test-db'

const harness = await createHarness()
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await harness.close()
  await owner.end()
})

const founded = z.object({ id: z.string() })
const MEMBER = '44444444-4444-4444-8444-444444444444'
const DEVICE = { endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a' }

async function foundGuild(name: string): Promise<string> {
  const res = await harness.request('/guilds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, goal: 'g' }),
  })
  return founded.parse(await res.json()).id
}

const request = (guildId: string) =>
  harness.adapters.seals.requestSeal(guildId, {
    questId: crypto.randomUUID(),
    requestedBy: 'herald-1',
    kind: 'post',
    text: 'seal',
    evidence: 'verdict: pass',
  })

/** Names the pool the test owns, so background work of other tests on the shared database is not counted. */
const POOL_NAME = 'seal-push-open-tx-test'

/** A notifier that takes its time and reports how many of this test's pool's transactions are open while it does. */
class SlowNotifier implements PushNotifier {
  readonly inner = new MemoryPushNotifier()
  openTransactions: number[] = []

  async send(subscription: PushSubscription, payload: PushPayload) {
    const [row] = await owner`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = ${POOL_NAME}
        and state like 'idle in transaction%'`
    this.openTransactions.push(z.object({ n: z.number() }).parse(row).n)
    await Bun.sleep(100)
    return this.inner.send(subscription, payload)
  }
}

describe('Seal push relay on Postgres with a tiny pool', () => {
  test('guilds dispatching at once against a slow notifier all finish: no pool deadlock', async () => {
    const small = createDb(testDbUrl('app'), { max: 2, applicationName: POOL_NAME })
    try {
      const notifier = new SlowNotifier()
      const store = new PgPushStore(small)
      const relay = createSealPushRelay({
        db: small,
        store,
        notifier,
        clock: new MemoryClock(new Date()),
        concurrency: 4,
      })
      const guilds = [await foundGuild('P1'), await foundGuild('P2'), await foundGuild('P3')]
      for (const g of guilds) {
        await store.add(g, MEMBER, DEVICE, 0)
        await request(g)
      }
      const finished = await Promise.race([
        Promise.all(guilds.map((g) => relay.dispatch(g))).then(() => 'done' as const),
        Bun.sleep(4000).then(() => 'hung' as const),
      ])
      expect(finished).toBe('done')
      expect(notifier.inner.sends).toHaveLength(3)
    } finally {
      await small.close()
    }
  })

  test('no transaction is open while a push is being sent', async () => {
    const small = createDb(testDbUrl('app'), { max: 4, applicationName: POOL_NAME })
    try {
      const notifier = new SlowNotifier()
      const store = new PgPushStore(small)
      const relay = createSealPushRelay({
        db: small,
        store,
        notifier,
        clock: new MemoryClock(new Date()),
      })
      const guild = await foundGuild('Quiet')
      await store.add(guild, MEMBER, DEVICE, 0)
      await request(guild)
      await relay.dispatch(guild)
      expect(notifier.openTransactions).toEqual([0])
    } finally {
      await small.close()
    }
  })
})
