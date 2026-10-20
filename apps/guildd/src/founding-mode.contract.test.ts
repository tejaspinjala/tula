import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createHarness } from './testing/harness'
import { withClusterDdlLock } from './testing/test-db'

type Mode = 'open' | 'once' | 'closed'

/** A harness on its own database (the founding lock looks at every guild) in the given mode. */
async function withMode<T>(
  foundingMode: Mode | undefined,
  run: (found: () => Promise<Response>) => Promise<T>
): Promise<T> {
  const harness = await createHarness({
    isolatedDb: true,
    ...(foundingMode ? { app: { foundingMode } } : {}),
  })
  try {
    return await run(() =>
      harness.request('/guilds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ember', goal: 'Ship a newsletter' }),
      })
    )
  } finally {
    await harness.close()
  }
}

const closedBody = z.object({ error: z.literal('founding_closed') })

describe('FOUNDING_MODE', () => {
  test('once: the first founding succeeds and the second is refused', async () => {
    await withMode('once', async (found) => {
      expect((await found()).status).toBe(201)
      const second = await found()
      expect(second.status).toBe(403)
      closedBody.parse(await second.json())
    })
  })

  test('closed: refuses even with no guild', async () => {
    await withMode('closed', async (found) => {
      const res = await found()
      expect(res.status).toBe(403)
      closedBody.parse(await res.json())
    })
  })

  test('open (and unset): founds as many guilds as asked', async () => {
    for (const mode of ['open', undefined] as const) {
      await withMode(mode, async (found) => {
        expect((await found()).status).toBe(201)
        expect((await found()).status).toBe(201)
      })
    }
  })

  test('once: two concurrent foundings produce exactly one guild', async () => {
    await withMode('once', async (found) => {
      const results = await Promise.all([found(), found(), found(), found()])
      const statuses = results.map((r) => r.status).sort()
      expect(statuses).toEqual([201, 403, 403, 403])
    })
  })
})

describe('FOUNDING_MODE under a busy shared cluster', () => {
  test('a founding test whose database setup waits on other workers still passes', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const locked = new Promise<void>((resolve) => {
      void withClusterDdlLock(async () => {
        resolve()
        await held
      })
    })
    await locked
    setTimeout(release, 6_000)
    await withMode('closed', async (found) => {
      expect((await found()).status).toBe(403)
    })
  })
})
