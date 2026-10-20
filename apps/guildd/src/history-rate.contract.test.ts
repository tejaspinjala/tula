import { expect, test } from 'bun:test'
import type { RouteLimits } from './rate-limits'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const LIMIT = 2

/** A harness whose `events-history` limits are `limits`, with a guild and a signed-in session. */
async function setup(limits: RouteLimits) {
  const harness = await createHarness({
    // Rate-limit counters persist in the shared test database, keyed by window: a window of our
    // own keeps reruns from inheriting a previous run's count.
    now: new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000),
    app: { rateLimits: { ...UNLIMITED_RATE_LIMITS, 'events-history': limits } },
  })
  const guildId = await harness.foundGuild({ name: 'History', goal: 'g' })
  const key = await SoftwareAuthenticator.create('localhost', 'http://localhost:5173')
  const founding = await harness.adapters.identity.issueFoundingToken(guildId)
  const reg = await harness.adapters.identity.beginRegistration(guildId, {
    foundingToken: founding.token,
  })
  await harness.adapters.identity.finishRegistration(
    guildId,
    reg.challengeId,
    await key.register(reg.options)
  )
  const sign = await harness.adapters.identity.beginSignIn(guildId)
  const { token } = await harness.adapters.identity.finishSignIn(
    guildId,
    sign.challengeId,
    await key.assert(sign.options)
  )
  const read = () =>
    harness.request(`/guilds/${guildId}/events/history`, {
      headers: { authorization: `Bearer ${token}` },
    })
  return { harness, read }
}

async function expectRefusedAfterLimit(limits: RouteLimits) {
  const { harness, read } = await setup(limits)
  try {
    for (let i = 0; i < LIMIT; i++) {
      expect((await read()).status).toBe(200)
    }
    const refused = await read()
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).not.toBeNull()
  } finally {
    await harness.close()
  }
}

test('history reads are limited per client: the extra read is a 429 with Retry-After', async () => {
  await expectRefusedAfterLimit({ client: { limit: LIMIT, windowMs: 60_000 } })
})

test('history reads are limited per guild across clients', async () => {
  await expectRefusedAfterLimit({
    client: { limit: 1000, windowMs: 60_000 },
    guild: { limit: LIMIT, windowMs: 60_000 },
  })
})
