import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createHarness } from './testing/harness'

type Mode = 'open' | 'once' | 'closed'

const status = z.object({ open: z.boolean() }).strict()

async function withMode<T>(
  foundingMode: Mode | undefined,
  run: (h: Awaited<ReturnType<typeof createHarness>>) => Promise<T>
): Promise<T> {
  const harness = await createHarness({
    isolatedDb: true,
    ...(foundingMode ? { app: { foundingMode } } : {}),
  })
  try {
    return await run(harness)
  } finally {
    await harness.close()
  }
}

async function open(h: Awaited<ReturnType<typeof createHarness>>): Promise<boolean> {
  const res = await h.request('/founding')
  expect(res.status).toBe(200)
  return status.parse(await res.json()).open
}

describe('GET /founding', () => {
  test('open (and unset) is open, before and after a guild exists', async () => {
    for (const mode of ['open', undefined] as const) {
      await withMode(mode, async (h) => {
        expect(await open(h)).toBe(true)
        await h.foundGuild({ name: 'First', goal: 'g' })
        expect(await open(h)).toBe(true)
      })
    }
  })

  test('once is open until a guild exists, then closed', async () => {
    await withMode('once', async (h) => {
      expect(await open(h)).toBe(true)
      await h.foundGuild({ name: 'First', goal: 'g' })
      expect(await open(h)).toBe(false)
    })
  })

  test('closed is never open', async () => {
    await withMode('closed', async (h) => {
      expect(await open(h)).toBe(false)
    })
  })

  test('answers a boolean only, with no guild data', async () => {
    await withMode('once', async (h) => {
      await h.foundGuild({ name: 'Secret name', goal: 'g' })
      const text = await (await h.request('/founding')).text()
      expect(text).toBe('{"open":false}')
    })
  })
})
