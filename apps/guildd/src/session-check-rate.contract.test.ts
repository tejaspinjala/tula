import { expect, test } from 'bun:test'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'

const LIMIT = 2

async function expectRefusedAfterLimit(method: 'GET' | 'POST', path: string) {
  const harness = await createHarness({
    isolatedDb: true,
    app: {
      rateLimits: {
        ...UNLIMITED_RATE_LIMITS,
        'session-check': { client: { limit: LIMIT, windowMs: 60_000 } },
      },
    },
  })
  try {
    const call = () => harness.request(path, { method })
    for (let i = 0; i < LIMIT; i++) {
      expect((await call()).status).not.toBe(429)
    }
    const refused = await call()
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).not.toBeNull()
  } finally {
    await harness.close()
  }
}

test('session checks are limited per client: the extra call is a 429 with Retry-After', async () => {
  await expectRefusedAfterLimit('GET', '/session')
})

test('sign-outs are limited per client: the extra call is a 429 with Retry-After', async () => {
  await expectRefusedAfterLimit('POST', '/session/logout')
})
