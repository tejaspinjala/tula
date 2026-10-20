import { afterAll, describe, expect, test } from 'bun:test'
import { createHarness } from './testing/harness'

const harness = await createHarness({ now: new Date('2026-01-02T03:04:05.000Z') })
afterAll(() => harness.close())

describe('GET /health', () => {
  test('answers 200 with status ok and the clock time', async () => {
    const res = await harness.request('/health')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', time: '2026-01-02T03:04:05.000Z' })
  })

  test('advancing the memory clock changes the reported time', async () => {
    harness.adapters.clock.advance(1000)

    const res = await harness.request('/health')

    expect(await res.json()).toEqual({ status: 'ok', time: '2026-01-02T03:04:06.000Z' })
  })
})
