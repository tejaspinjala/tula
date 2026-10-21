import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { appendEvent } from './events'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const sessionsBody = z.object({
  sessions: z.array(
    z.object({ id: z.string(), questTitle: z.string().nullable(), halted: z.boolean() })
  ),
})
const digestBody = z.object({
  entries: z.array(z.object({ kind: z.string(), questTitle: z.string().nullable() })),
})

async function found() {
  const guild = await harness.foundGuild({ name: 'Titles', goal: 'g' })
  return { guild, token: await openSession(harness.adapters.identity, guild) }
}

async function postQuest(guild: string, title: string): Promise<string> {
  const { quest } = await harness.adapters.quests.post(guild, {
    jobKey: crypto.randomUUID(),
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title,
    ownerId: 'heralds-member-1',
    doneCondition: 'An announcement draft is ready for a Seal',
    roundLimit: 2,
  })
  return quest.id
}

async function convene(guild: string, questId: string): Promise<string> {
  const opened = await harness.adapters.councilStore.open(guild, {
    questId,
    proposalHash: crypto.randomUUID().replaceAll('-', '').repeat(2),
    day: '2026-01-01',
    sessionCap: 50,
  })
  if (opened.status === 'cap_reached') {
    throw new Error('cap')
  }
  return opened.session.id
}

const auth = (token: string) => ({ headers: { authorization: `Bearer ${token}` } })

describe('Quest titles and the halted flag on the Council reads', () => {
  test('council sessions carry the Quest title and a halted flag, never another guild title', async () => {
    const a = await found()
    const b = await found()
    const titled = await postQuest(a.guild, 'Announce market day')
    const foreign = await postQuest(b.guild, 'Secret of guild B')
    const s1 = await convene(a.guild, titled)
    const s2 = await convene(a.guild, foreign)
    await harness.adapters.councilStore.halt(a.guild, s1, titled)
    const res = await harness.request(`/guilds/${a.guild}/council/sessions`, auth(a.token))
    expect(res.status).toBe(200)
    const byId = new Map(sessionsBody.parse(await res.json()).sessions.map((s) => [s.id, s]))
    expect(byId.get(s1)).toMatchObject({ questTitle: 'Announce market day', halted: true })
    expect(byId.get(s2)).toMatchObject({ questTitle: null, halted: false })
  })

  test('digest entries carry the Quest title, null for a Quest of another guild', async () => {
    const a = await found()
    const b = await found()
    const mine = await postQuest(a.guild, 'Announce market day')
    const foreign = await postQuest(b.guild, 'Secret of guild B')
    await harness.adapters.db.withGuild(a.guild, async (tx) => {
      await appendEvent(tx, harness.adapters.keys, 'guildmaster.away', {
        since: new Date().toISOString(),
        until: null,
      })
      await appendEvent(tx, harness.adapters.keys, 'quest.done', {
        questId: mine,
        hallId: 'h',
        attempt: 1,
      })
      await appendEvent(tx, harness.adapters.keys, 'quest.done', {
        questId: foreign,
        hallId: 'h',
        attempt: 1,
      })
    })
    const res = await harness.request(`/guilds/${a.guild}/guild-master/away-digest`, auth(a.token))
    expect(res.status).toBe(200)
    expect(digestBody.parse(await res.json()).entries.map((e) => e.questTitle)).toEqual([
      'Announce market day',
      null,
    ])
  })
})
