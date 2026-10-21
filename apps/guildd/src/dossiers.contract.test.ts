import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { PgHandoffStore } from './adapters/pg-handoff-store'
import type { Handoff } from './ports/handoff-store'
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
const handoffs = new PgHandoffStore(harness.adapters.db, harness.adapters.keys)

const dossierBody = z.object({
  id: z.string(),
  subjectQuestId: z.string(),
  subjectHallId: z.string(),
  verified: z.boolean(),
  failedChecks: z.array(z.string()),
  hash: z.string(),
  requester: z.object({ kind: z.string() }),
  body: z.object({ goal: z.string(), handoffHash: z.string() }),
})
const pageBody = z.object({ dossiers: z.array(dossierBody), next: z.number().nullable() })

async function found(): Promise<string> {
  const g = await harness.foundGuild({ name: 'Dossiers', goal: 'g' })
  await harness.adapters.config.seed(g)
  tokens.set(g, await openSession(harness.adapters.identity, g))
  return g
}

/** A Quest in the Heralds Hall that ran once and recorded a Handoff citing `artifact`. */
async function finished(
  g: string,
  over: { stored?: boolean; handoff?: boolean; requeued?: boolean } = {}
) {
  const { quest } = await harness.adapters.quests.post(g, {
    jobKey: crypto.randomUUID(),
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'private',
    title: 'Brief',
    ownerId: 'heralds-member-2',
    doneCondition: 'It ships',
    roundLimit: 2,
  })
  await harness.adapters.quests.claim(g, {
    leaseMs: 60_000,
    maxActive: 10,
    hallCaps: {},
    questId: quest.id,
  })
  const artifact =
    over.stored === false
      ? 'd'.repeat(64)
      : await harness.adapters.objectStore.put(g, new TextEncoder().encode('the brief'))
  const handoff: Handoff = {
    goal: 'Ship the brief',
    doneCondition: 'It ships',
    met: true,
    evidence: [{ kind: 'artifact', ref: artifact }],
    openItems: [],
    artifacts: [artifact],
  }
  if (over.handoff !== false) {
    await handoffs.record(g, quest.id, 1, 'heralds-member-2', handoff)
    if (over.requeued) {
      await harness.adapters.quests.fail(g, quest.id, 1, 'unknown')
    } else {
      await harness.adapters.quests.complete(g, quest.id, 1)
    }
  }
  return { quest, artifact }
}

const create = (g: string, questId: string) =>
  harness.request(`/guilds/${g}/dossiers`, {
    method: 'POST',
    headers: headers(g),
    body: JSON.stringify({ questId }),
  })

describe('Dossier routes', () => {
  test('the Guild Master creates a Dossier for a finished Quest, even a private-class one, and it is verified', async () => {
    const g = await found()
    const { quest } = await finished(g)
    const res = await create(g, quest.id)
    expect(res.status).toBe(201)
    const d = dossierBody.parse(await res.json())
    expect(d).toMatchObject({
      subjectQuestId: quest.id,
      subjectHallId: 'heralds',
      verified: true,
      failedChecks: [],
      requester: { kind: 'guild_master' },
      body: { goal: 'Ship the brief' },
    })
  })

  test('a Dossier with a missing artifact is stored unverified with the failed check named', async () => {
    const g = await found()
    const { quest, artifact } = await finished(g, { stored: false })
    const d = dossierBody.parse(await (await create(g, quest.id)).json())
    expect(d).toMatchObject({ verified: false, failedChecks: [`artifact_missing:${artifact}`] })
  })

  test('a Quest without a Handoff is refused 422 quest_not_finished, an unknown one 404', async () => {
    const g = await found()
    const { quest } = await finished(g, { handoff: false })
    const res = await create(g, quest.id)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'quest_not_finished' })
    expect((await create(g, crypto.randomUUID())).status).toBe(404)
    expect((await create(g, 'not-a-uuid')).status).toBe(400)
  })

  test('a Quest re-queued after an attempt handed off is refused 422 quest_not_finished', async () => {
    const g = await found()
    const { quest } = await finished(g, { requeued: true })
    const res = await create(g, quest.id)
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'quest_not_finished' })
  })

  test('a Hall lists its Dossiers newest first in pages, and one is read by id', async () => {
    const g = await found()
    const { quest } = await finished(g)
    const ids: string[] = []
    for (const _ of [1, 2, 3]) {
      ids.push(dossierBody.parse(await (await create(g, quest.id)).json()).id)
    }
    const url = `/guilds/${g}/halls/heralds/dossiers`
    const first = pageBody.parse(
      await (await harness.request(`${url}?limit=2`, { headers: headers(g) })).json()
    )
    expect(first.dossiers.map((d) => d.id)).toEqual(ids.slice(1).reverse())
    expect(first.next).not.toBeNull()
    const second = pageBody.parse(
      await (
        await harness.request(`${url}?limit=2&after=${first.next}`, { headers: headers(g) })
      ).json()
    )
    expect(second.dossiers.map((d) => d.id)).toEqual(ids.slice(0, 1))
    expect(second.next).toBeNull()
    const one = await harness.request(`/guilds/${g}/dossiers/${ids[1]}`, { headers: headers(g) })
    expect(dossierBody.parse(await one.json()).id).toBe(ids[1] ?? '')
  })

  test('a bad page, an unknown Hall or an unknown Dossier is refused', async () => {
    const g = await found()
    const get = (path: string) => harness.request(path, { headers: headers(g) })
    expect((await get(`/guilds/${g}/halls/heralds/dossiers?limit=0`)).status).toBe(400)
    expect((await get(`/guilds/${g}/halls/heralds/dossiers?limit=101`)).status).toBe(400)
    expect((await get(`/guilds/${g}/halls/heralds/dossiers?after=abc`)).status).toBe(400)
    expect((await get(`/guilds/${g}/halls/no-such-hall/dossiers`)).status).toBe(404)
    expect((await get(`/guilds/${g}/dossiers/${crypto.randomUUID()}`)).status).toBe(404)
    expect((await get(`/guilds/${g}/dossiers/not-a-uuid`)).status).toBe(404)
  })

  test('without a session every route answers 401', async () => {
    const g = await strict.foundGuild({ name: 'Dossiers', goal: 'g' })
    await strict.adapters.config.seed(g)
    const h = { 'x-guild-id': g, 'content-type': 'application/json' }
    for (const [path, init] of [
      [`/guilds/${g}/halls/heralds/dossiers`, { headers: h }],
      [`/guilds/${g}/dossiers/${crypto.randomUUID()}`, { headers: h }],
      [
        `/guilds/${g}/dossiers`,
        { method: 'POST', headers: h, body: JSON.stringify({ questId: crypto.randomUUID() }) },
      ],
    ] as const) {
      expect((await strict.request(path, init)).status).toBe(401)
    }
  })

  test('cross-guild probes: another guild looks like a missing one on every route', async () => {
    const caller = await found()
    const mine = await finished(caller)
    const own = dossierBody.parse(await (await create(caller, mine.quest.id)).json())
    const snapshot = (g: string) =>
      harness.adapters.dossierStore.list(g, { hallId: 'heralds', limit: 100 })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [
        `/guilds/${target}/halls/heralds/dossiers`,
        { headers: headers(caller) },
      ],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [`/guilds/${target}/dossiers/${own.id}`, { headers: headers(caller) }],
      snapshot,
    })
    await expectGuildIsolation(harness, {
      build: (_c, target) => [
        `/guilds/${target}/dossiers`,
        {
          method: 'POST',
          headers: headers(caller),
          body: JSON.stringify({ questId: mine.quest.id }),
        },
      ],
      snapshot,
    })
  })
})
