import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { WHOLE_HALL } from './ports/missive-store'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: true })
const strict = await createHarness({ devGuildHeader: false })
afterAll(async () => {
  await harness.close()
  await strict.close()
})

const pageBody = z.object({
  missives: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      text: z.string(),
      hallId: z.string(),
      toHall: z.string().nullable(),
    })
  ),
  next: z.number().nullable(),
})

async function found(): Promise<string> {
  const g = await harness.foundGuild({ name: 'Missives', goal: 'g' })
  await harness.adapters.config.seed(g)
  tokens.set(g, await openSession(harness.adapters.identity, g))
  return g
}

const base = (g: string, hall = 'heralds') => `/guilds/${g}/halls/${hall}/missives`
const tokens = new Map<string, string>()
const headers = (g: string) => ({ authorization: `Bearer ${tokens.get(g) ?? 'none'}` })

async function sendSome(g: string, texts: string[], hallId = 'heralds') {
  const questId = crypto.randomUUID()
  for (const text of texts) {
    await harness.adapters.missives.send(g, {
      hallId,
      questId,
      attempt: 1,
      from: 'heralds-member-2',
      to: WHOLE_HALL,
      text,
      maxPerQuest: 100,
      at: new Date(),
    })
  }
}

describe('Hall missives route', () => {
  test('the Guild Master reads a Hall’s Missives newest first, in pages', async () => {
    const g = await found()
    await sendSome(g, ['m1', 'm2', 'm3'])
    await sendSome(g, ['elsewhere'], 'scribes')
    const first = pageBody.parse(
      await (await harness.request(`${base(g)}?limit=2`, { headers: headers(g) })).json()
    )
    expect(first.missives.map((m) => m.text)).toEqual(['m3', 'm2'])
    expect(first.next).not.toBeNull()
    const second = pageBody.parse(
      await (
        await harness.request(`${base(g)}?limit=2&after=${first.next}`, { headers: headers(g) })
      ).json()
    )
    expect(second.missives.map((m) => m.text)).toEqual(['m1'])
    expect(second.next).toBeNull()
  })

  test('a cross-Hall Missive is in the ledger of both Halls with both Hall ids', async () => {
    const g = await found()
    await harness.adapters.missives.send(g, {
      hallId: 'health',
      toHall: 'heralds',
      questId: crypto.randomUUID(),
      attempt: 1,
      from: 'health-m',
      to: WHOLE_HALL,
      text: 'across',
      maxPerQuest: 100,
      at: new Date(),
    })
    for (const hall of ['heralds', 'health']) {
      const page = pageBody.parse(
        await (await harness.request(base(g, hall), { headers: headers(g) })).json()
      )
      expect(page.missives.map((m) => [m.text, m.hallId, m.toHall])).toEqual([
        ['across', 'health', 'heralds'],
      ])
    }
  })

  test('the text comes back as the sender wrote it, unframed', async () => {
    const g = await found()
    await sendSome(g, ['<b>hello</b> & more'])
    const page = pageBody.parse(
      await (await harness.request(base(g), { headers: headers(g) })).json()
    )
    expect(page.missives[0]?.text).toBe('<b>hello</b> & more')
  })

  test('a bad page, or a Hall the guild does not have, is refused', async () => {
    const g = await found()
    const get = (path: string) => harness.request(path, { headers: headers(g) })
    expect((await get(`${base(g)}?limit=0`)).status).toBe(400)
    expect((await get(`${base(g)}?limit=101`)).status).toBe(400)
    expect((await get(`${base(g)}?after=abc`)).status).toBe(400)
    expect((await get(base(g, 'no-such-hall'))).status).toBe(404)
  })

  test('without a session the route answers 401', async () => {
    const g = await strict.foundGuild({ name: 'Missives', goal: 'g' })
    await strict.adapters.config.seed(g)
    const res = await strict.request(base(g), { headers: { 'x-guild-id': g } })
    expect(res.status).toBe(401)
  })

  test('a session whose principal is not the Guild Master gets 403; the Guild Master still reads', async () => {
    const g = await found()
    const token = tokens.get(g) ?? 'none'
    const identity = harness.adapters.identity
    // Test-only: the same identity, except every session resolves to a non-Guild-Master member.
    const demoted = new Proxy(identity, {
      get(target, prop) {
        if (prop === 'resolveSession') {
          return async (t: string) => {
            const principal = await target.resolveSession(t)
            return principal && { ...principal, role: 'agent' }
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const limited = await createHarness({ devGuildHeader: false, app: { identity: demoted } })
    try {
      const auth = { authorization: `Bearer ${token}` }
      expect((await limited.request(base(g), { headers: auth })).status).toBe(403)
      expect((await harness.request(base(g), { headers: auth })).status).toBe(200)
    } finally {
      await limited.close()
    }
  })

  test('cross-guild probe: another guild looks like a missing one', async () => {
    const caller = await found()
    await expectGuildIsolation(harness, {
      build: (_caller, target) => [base(target), { headers: headers(caller) }],
      snapshot: (g) => harness.adapters.missives.list(g, { hallId: 'heralds', limit: 100 }),
    })
  })
})
