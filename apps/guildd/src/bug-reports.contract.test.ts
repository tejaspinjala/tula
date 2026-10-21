import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: true })
const strict = await createHarness({ devGuildHeader: false })
afterAll(async () => {
  await harness.close()
  await strict.close()
})

const tokens = new Map<string, string>()
const headers = (g: string) => ({
  authorization: `Bearer ${tokens.get(g) ?? 'none'}`,
  'content-type': 'application/json',
})

const report = z.object({
  id: z.string(),
  status: z.string(),
  owningHall: z.string(),
  duplicateOf: z.string().nullable(),
  fixQuestId: z.string().nullable(),
  filer: z.object({ kind: z.string() }),
})
const page = z.object({ reports: z.array(report), next: z.number().nullable() })

async function found(): Promise<string> {
  const g = await harness.foundGuild({ name: 'Bugs', goal: 'g' })
  await harness.adapters.config.seed(g)
  tokens.set(g, await openSession(harness.adapters.identity, g))
  return g
}

const repro = { steps: 'Open it', expected: 'works', actual: 'breaks' }
const file = (g: string, over: Record<string, unknown> = {}) =>
  harness.request(`/guilds/${g}/bug-reports`, {
    method: 'POST',
    headers: headers(g),
    body: JSON.stringify({
      owningHall: 'heralds',
      title: 'It breaks',
      reproduction: repro,
      evidence: [],
      ...over,
    }),
  })

describe('Bug Report routes', () => {
  test('the Guild Master files a report and a Fix Quest is on the Hall board', async () => {
    const g = await found()
    const res = await file(g)
    expect(res.status).toBe(201)
    const filed = report.parse(await res.json())
    expect(filed).toMatchObject({
      status: 'open',
      owningHall: 'heralds',
      filer: { kind: 'guild_master' },
    })
    const fix = await harness.adapters.quests.get(g, filed.fixQuestId ?? '')
    expect(fix).toMatchObject({ templateId: 'fix-quest', hallId: 'heralds', board: true })
  })

  test('a repeat is stored duplicate and posts no second Fix Quest', async () => {
    const g = await found()
    const first = report.parse(await (await file(g)).json())
    const second = report.parse(await (await file(g)).json())
    expect(second).toMatchObject({ status: 'duplicate', duplicateOf: first.id, fixQuestId: null })
    expect((await harness.adapters.quests.list(g, { limit: 50 })).quests).toHaveLength(1)
  })

  test('a missing reproduction is 422 reproduction_required, an unknown Hall 404, bad input 400', async () => {
    const g = await found()
    const missing = await file(g, { reproduction: { steps: 'x', expected: ' ' } })
    expect(missing.status).toBe(422)
    expect(await missing.json()).toEqual({ error: 'reproduction_required' })
    expect((await file(g, { reproduction: undefined })).status).toBe(422)
    expect((await file(g, { owningHall: 'no-such-hall' })).status).toBe(404)
    expect((await file(g, { title: 'x'.repeat(121) })).status).toBe(400)
    expect(
      (await file(g, { evidence: Array.from({ length: 21 }, () => 'a'.repeat(64)) })).status
    ).toBe(400)
    expect((await file(g, { evidence: ['not-evidence'] })).status).toBe(400)
  })

  test('a paused owning Hall refuses hall_paused: no Fix Quest and no report', async () => {
    const g = await found()
    await harness.adapters.tripwires.pause(g, {
      hallId: 'heralds',
      tripwire: 'manual',
      observed: 1,
      threshold: 1,
    })
    const res = await file(g)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'hall_paused' })
    expect((await harness.adapters.quests.list(g, { limit: 50 })).quests).toHaveLength(0)
    expect(await harness.adapters.bugReportStore.list(g, { hallId: 'heralds', limit: 10 })).toEqual(
      { reports: [], next: null }
    )
  })

  test('a report at the maximum field lengths files, and its Fix Quest carries none of the reproduction text', async () => {
    const g = await found()
    const res = await file(g, {
      title: 'T'.repeat(120),
      reproduction: { steps: 'S'.repeat(600), expected: 'E'.repeat(600), actual: 'A'.repeat(600) },
    })
    expect(res.status).toBe(201)
    const filed = report.parse(await res.json())
    const fix = await harness.adapters.quests.get(g, filed.fixQuestId ?? '')
    expect(fix?.doneCondition.length).toBeLessThanOrEqual(300)
    expect(fix?.title.length).toBeLessThanOrEqual(120)
    expect(`${fix?.title}${fix?.doneCondition}`).not.toMatch(/S{5}|E{5}|A{5}|T{5}/)
  })

  test('a Hall lists its reports newest first in pages, by status, and one is read by id', async () => {
    const g = await found()
    const ids: string[] = []
    for (const tag of ['a', 'b', 'c']) {
      ids.push(
        report.parse(await (await file(g, { reproduction: { ...repro, steps: tag } })).json()).id
      )
    }
    await file(g, { reproduction: { ...repro, steps: 'a' } })
    const get = (path: string) => harness.request(path, { headers: headers(g) })
    const url = `/guilds/${g}/halls/heralds/bug-reports`
    const first = page.parse(await (await get(`${url}?limit=2`)).json())
    expect(first.reports.map((r) => r.status)).toEqual(['duplicate', 'open'])
    const second = page.parse(await (await get(`${url}?limit=2&after=${first.next}`)).json())
    expect(second.reports.map((r) => r.id)).toEqual([ids[1] ?? '', ids[0] ?? ''])
    expect(second.next).toBeNull()
    const dups = page.parse(await (await get(`${url}?status=duplicate`)).json())
    expect(dups.reports).toHaveLength(1)
    const one = await get(`/guilds/${g}/bug-reports/${ids[2]}`)
    expect(report.parse(await one.json()).id).toBe(ids[2] ?? '')
  })

  test('a bad page, an unknown Hall or an unknown report is refused', async () => {
    const g = await found()
    const get = (path: string) => harness.request(path, { headers: headers(g) })
    expect((await get(`/guilds/${g}/halls/heralds/bug-reports?limit=0`)).status).toBe(400)
    expect((await get(`/guilds/${g}/halls/heralds/bug-reports?status=weird`)).status).toBe(400)
    expect((await get(`/guilds/${g}/halls/no-such-hall/bug-reports`)).status).toBe(404)
    expect((await get(`/guilds/${g}/bug-reports/${crypto.randomUUID()}`)).status).toBe(404)
    expect((await get(`/guilds/${g}/bug-reports/not-a-uuid`)).status).toBe(404)
  })

  test('without a session every route answers 401', async () => {
    const g = await strict.foundGuild({ name: 'Bugs', goal: 'g' })
    await strict.adapters.config.seed(g)
    const h = { 'x-guild-id': g, 'content-type': 'application/json' }
    for (const [path, init] of [
      [`/guilds/${g}/halls/heralds/bug-reports`, { headers: h }],
      [`/guilds/${g}/bug-reports/${crypto.randomUUID()}`, { headers: h }],
      [`/guilds/${g}/bug-reports`, { method: 'POST', headers: h, body: '{}' }],
    ] as const) {
      expect((await strict.request(path, init)).status).toBe(401)
    }
  })

  test('cross-guild probes: another guild looks like a missing one on every route', async () => {
    const caller = await found()
    const own = report.parse(await (await file(caller)).json())
    const snapshot = (g: string) =>
      harness.adapters.bugReportStore.list(g, { hallId: 'heralds', limit: 100 })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [
        `/guilds/${target}/halls/heralds/bug-reports`,
        { headers: headers(caller) },
      ],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [
        `/guilds/${target}/bug-reports/${own.id}`,
        { headers: headers(caller) },
      ],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [
        `/guilds/${target}/bug-reports`,
        {
          method: 'POST',
          headers: headers(caller),
          body: JSON.stringify({ owningHall: 'heralds', title: 't', reproduction: repro }),
        },
      ],
      snapshot,
    })
  })
})
