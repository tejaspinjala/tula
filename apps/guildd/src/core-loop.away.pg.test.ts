import { afterAll, expect, test } from 'bun:test'
import { z } from 'zod'
import { PgGateStore } from './adapters/pg-gate-store'
import { requestQuestSeal } from './core-loop'
import { CouncilEngine } from './council'
import { eventsAfter } from './events'
import { defaultConfig, guildConfig } from './guild-config'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'
import { ScriptedCouncilModel, voteReply } from './testing/scripted-council-model'

const harness = await createHarness({ devGuildHeader: false })
afterAll(async () => {
  await harness.close()
})

const entry = z.object({
  kind: z.string(),
  questId: z.string().nullable(),
  sessionId: z.string().nullable(),
  sealId: z.string().nullable(),
  reason: z.string().nullable(),
  amountCents: z.number().nullable(),
})
const digest = z.object({
  window: z.object({ open: z.boolean() }).nullable(),
  entries: z.array(entry),
  next: z.number().nullable(),
  spendTotalCents: z.number(),
})

/** A guild under `routine_alone`, with its Guild Master signed in. */
async function guild(name: string) {
  const a = harness.adapters
  const id = await harness.foundGuild({ name, goal: 'g' })
  await a.config.seed(id)
  const proposed = await a.config.propose(
    id,
    guildConfig.parse({ ...defaultConfig(), sealPolicy: 'routine_alone' })
  )
  if (proposed.status === 'pending') {
    await a.config.confirm(id, proposed.version)
  }
  return { id, token: await openSession(a.identity, id) }
}

/** A Quest held for a Seal with one Proposal on it. */
async function heldQuest(
  guildId: string,
  key: string,
  dataClass: 'public' | 'private',
  content: string
) {
  const a = harness.adapters
  const { quest } = await a.quests.post(guildId, {
    jobKey: key,
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass,
    title: key,
    ownerId: 'heralds-member-1',
    doneCondition: 'An announcement draft is ready for a Seal',
    roundLimit: 2,
  })
  const claimed = await a.quests.claim(guildId, { leaseMs: 60_000, maxActive: 5 })
  const held = await a.quests.submitForSeal(guildId, quest.id, claimed?.attempts ?? 0)
  await a.proposals.propose(guildId, {
    questId: quest.id,
    author: 'heralds-member-1',
    kind: 'post',
    content,
  })
  return held
}

async function getJson(path: string, token: string): Promise<unknown> {
  const res = await harness.request(path, { headers: { authorization: `Bearer ${token}` } })
  expect(res.status).toBe(200)
  return res.json()
}

test('Milestone 3: the Guild Master away, the Council approves and escalates, the gates halt a session, the scroll lists it all, another guild sees none of it', async () => {
  const a = harness.adapters
  const home = await guild('Away Hall')
  const other = await guild('Other Hall')
  const gates = new PgGateStore(a.db, a.keys)
  const model = new ScriptedCouncilModel((call) =>
    call.brief.includes('BLOCKME') && call.system.includes('security voice')
      ? voteReply('block', 'Mentions an unreleased date')
      : voteReply('approve', 'fine')
  )
  const council = new CouncilEngine({
    store: a.councilStore,
    model,
    clock: a.clock,
    gates,
    config: a.config,
    presence: a.presence,
  })
  const deps = {
    quests: a.quests,
    sealStore: a.sealStore,
    proposals: a.proposals,
    seals: a.seals,
    config: a.config,
    presence: a.presence,
    clock: a.clock,
    gates,
    council,
  }

  const approvedQuest = await heldQuest(home.id, 'routine', 'public', 'Hello guild')
  const blockedQuest = await heldQuest(home.id, 'blocked', 'public', 'BLOCKME launch date')
  const privateQuest = await heldQuest(home.id, 'private', 'private', 'Private note')
  const haltedQuest = await heldQuest(home.id, 'halted', 'public', 'Another hello')

  const wentAway = await harness.request(`/guilds/${home.id}/guild-master/away`, {
    method: 'POST',
    headers: { authorization: `Bearer ${home.token}`, 'content-type': 'application/json' },
    body: '{}',
  })
  expect(wentAway.status).toBe(200)

  // A unanimous Council approves the routine Proposal: no Guild Master Seal.
  const approved = await requestQuestSeal(deps, home.id, approvedQuest)
  expect(approved.outcome).toBe('council_approved')
  expect(await a.quests.get(home.id, approvedQuest.id)).toMatchObject({
    state: 'done',
    lastError: 'council_approved',
  })

  // A block escalates: a Seal is requested with the Council's reasons.
  const blocked = await requestQuestSeal(deps, home.id, blockedQuest)
  expect(blocked.outcome).toBe('requested')
  const blockedSeal = await a.sealStore.forQuest(home.id, blockedQuest.id)
  expect(blockedSeal?.status).toBe('requested')
  expect(blockedSeal?.evidence).toContain('Mentions an unreleased date')

  // A private-class Proposal goes straight to a Seal: no session is convened for it.
  const callsBefore = model.calls.length
  expect((await requestQuestSeal(deps, home.id, privateQuest)).outcome).toBe('requested')
  expect(model.calls.slice(callsBefore).every((c) => c.questId !== privateQuest.id)).toBe(true)
  expect((await a.sealStore.forQuest(home.id, privateQuest.id))?.status).toBe('requested')

  // Some spend while away.
  const spend = await a.treasury.requestSpend(home.id, {
    key: 'away-spend',
    amountCents: 150,
    purpose: 'Print flyers',
    requestedBy: 'heralds-member-1',
  })
  expect(spend.ok).toBe(true)

  // Bar the Gates halts the next session; the Quest stays Awaiting Seal.
  await gates.bar({ guildId: home.id, memberId: crypto.randomUUID() }, 'guild')
  expect((await requestQuestSeal(deps, home.id, haltedQuest)).outcome).toBe('council_pending')
  expect((await a.quests.get(home.id, haltedQuest.id))?.state).toBe('awaiting_seal')
  const names = (await a.db.withGuild(home.id, (tx) => eventsAfter(tx, 0, 1000))).map((e) => e.type)
  expect(names.filter((n) => n === 'council.halted')).toHaveLength(1)
  expect(names).not.toContain('seal.approved')

  // The Guild Master returns: the digest lists all of it.
  const returned = await harness.request(`/guilds/${home.id}/guild-master/return`, {
    method: 'POST',
    headers: { authorization: `Bearer ${home.token}` },
  })
  expect(returned.status).toBe(200)
  const scroll = digest.parse(
    await getJson(`/guilds/${home.id}/guild-master/away-digest`, home.token)
  )
  expect(scroll.window?.open).toBe(false)
  const of = (kind: string) => scroll.entries.filter((e) => e.kind === kind)
  expect(of('council_approved').map((e) => e.questId)).toEqual([approvedQuest.id])
  expect(of('escalated').map((e) => [e.questId, e.reason])).toEqual([[blockedQuest.id, 'block']])
  expect(of('council_halted')).toHaveLength(1)
  expect(
    of('seal_waiting')
      .map((e) => e.questId)
      .sort()
  ).toEqual([blockedQuest.id, privateQuest.id].sort())
  expect(of('spend').map((e) => e.amountCents)).toEqual([150])
  expect(scroll.spendTotalCents).toBe(150)
  // The approved Quest's done line is folded into its approval.
  expect(of('quest_done').map((e) => e.questId)).not.toContain(approvedQuest.id)

  // The Council panel lists this guild's sessions.
  const sessions = z
    .object({ sessions: z.array(z.object({ id: z.string() })) })
    .parse(await getJson(`/guilds/${home.id}/council/sessions`, home.token))
  expect(sessions.sessions.length).toBeGreaterThanOrEqual(3)

  // A second guild sees none of it.
  const otherScroll = digest.parse(
    await getJson(`/guilds/${other.id}/guild-master/away-digest`, other.token)
  )
  expect(otherScroll).toEqual({ window: null, entries: [], next: null, spendTotalCents: 0 })
  const otherSessions = z
    .object({ sessions: z.array(z.unknown()) })
    .parse(await getJson(`/guilds/${other.id}/council/sessions`, other.token))
  expect(otherSessions.sessions).toEqual([])
  const presence = z
    .object({ away: z.boolean() })
    .parse(await getJson(`/guilds/${other.id}/guild-master/presence`, other.token))
  expect(presence.away).toBe(false)
  const otherEvents = (await a.db.withGuild(other.id, (tx) => eventsAfter(tx, 0, 1000))).map(
    (e) => e.type
  )
  expect(otherEvents.filter((t) => t.startsWith('council.') || t === 'guildmaster.away')).toEqual(
    []
  )
})
