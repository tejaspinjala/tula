import { expect, test } from 'bun:test'
import type { RouteLimits } from './rate-limits'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { openSession } from './testing/open-session'

const LIMIT = 2

/** A harness whose presence limits are `limits`, with a guild and a signed-in Guild Master session. */
async function setup(limits: { read?: RouteLimits; write?: RouteLimits }) {
  const harness = await createHarness({
    // Rate-limit counters persist in the shared test database, keyed by window: a window of our
    // own keeps reruns from inheriting a previous run's count.
    now: new Date(Date.UTC(2041, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000),
    app: {
      rateLimits: {
        ...UNLIMITED_RATE_LIMITS,
        ...(limits.read ? { 'presence-read': limits.read } : {}),
        ...(limits.write ? { 'presence-write': limits.write } : {}),
      },
    },
  })
  const guild = await harness.foundGuild({ name: 'Presence', goal: 'g' })
  const token = await openSession(harness.adapters.identity, guild)
  const headers = { authorization: `Bearer ${token}` }
  const base = `/guilds/${guild}/guild-master`
  return {
    harness,
    read: () => harness.request(`${base}/presence`, { headers }),
    away: () => harness.request(`${base}/away`, { method: 'POST', headers, body: '{}' }),
    back: () => harness.request(`${base}/return`, { method: 'POST', headers }),
  }
}

test('presence reads are limited: the extra read is a 429 with Retry-After', async () => {
  const { harness, read } = await setup({ read: { client: { limit: LIMIT, windowMs: 60_000 } } })
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
})

test('away and return share the presence write bucket: the extra write is a 429', async () => {
  const { harness, away, back } = await setup({
    write: { client: { limit: LIMIT, windowMs: 60_000 } },
  })
  try {
    expect((await away()).status).toBe(200)
    expect((await back()).status).toBe(200)
    expect((await away()).status).toBe(429)
    expect((await back()).status).toBe(429)
  } finally {
    await harness.close()
  }
})
