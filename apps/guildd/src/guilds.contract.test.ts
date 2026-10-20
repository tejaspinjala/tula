import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())

describe('founding a guild', () => {
  test('POST /guilds creates the guild and returns its id; GET returns it to its own guild', async () => {
    const res = await harness.request('/guilds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ember Guild', goal: 'Ship a weekly newsletter' }),
    })
    expect(res.status).toBe(201)
    const { id } = z.object({ id: z.string() }).parse(await res.json())
    expect(id).toMatch(/^[0-9a-f-]{36}$/)

    const got = await harness.request(`/guilds/${id}`, { headers: { 'x-guild-id': id } })
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({
      id,
      name: 'Ember Guild',
      goal: 'Ship a weekly newsletter',
    })
  })

  test('the x-guild-id header is rejected unless the dev header flag is on', async () => {
    const strict = await createHarness({ devGuildHeader: false })
    try {
      const id = await strict.foundGuild({ name: 'A', goal: 'g' })
      const res = await strict.request(`/guilds/${id}`, { headers: { 'x-guild-id': id } })
      expect(res.status).toBe(401)
    } finally {
      await strict.close()
    }
  })

  test('rejects a guild without a name or goal', async () => {
    const res = await harness.request('/guilds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    expect(res.status).toBe(400)
  })
})
