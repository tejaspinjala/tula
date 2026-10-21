import { afterAll, expect, test } from 'bun:test'
import { PgGateStore } from './adapters/pg-gate-store'
import { requestQuestSeal } from './core-loop'
import { CouncilEngine } from './council'
import { eventsAfter } from './events'
import { defaultConfig, guildConfig } from './guild-config'
import { createHarness } from './testing/harness'
import { ScriptedCouncilModel, voteReply } from './testing/scripted-council-model'

const harness = await createHarness()
afterAll(async () => {
  await harness.close()
})

/** A guild whose Seal Policy is `routine_alone` with one Quest held for a Seal and a passing Verdict. */
async function world() {
  const a = harness.adapters
  const guild = await harness.foundGuild({ name: 'Council', goal: 'g' })
  await a.config.seed(guild)
  const proposed = await a.config.propose(
    guild,
    guildConfig.parse({ ...defaultConfig(), sealPolicy: 'routine_alone' })
  )
  if (proposed.status === 'pending') {
    await a.config.confirm(guild, proposed.version)
  }
  const { quest } = await a.quests.post(guild, {
    jobKey: 'k',
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title: 'Announce',
    ownerId: 'heralds-member-1',
    doneCondition: 'An announcement draft is ready for a Seal',
    roundLimit: 2,
  })
  const claimed = await a.quests.claim(guild, { leaseMs: 60_000, maxActive: 5 })
  const held = await a.quests.submitForSeal(guild, quest.id, claimed?.attempts ?? 0)
  await a.proposals.propose(guild, {
    questId: quest.id,
    author: 'heralds-member-1',
    kind: 'post',
    content: 'Hello guild',
  })
  await a.presence.goAway(guild, null)
  const gateStore = new PgGateStore(a.db, a.keys)
  const council = new CouncilEngine({
    store: a.councilStore,
    model: new ScriptedCouncilModel(() => voteReply('approve', 'fine')),
    clock: a.clock,
    gates: gateStore,
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
    gates: gateStore,
    council,
  }
  const types = async () => a.db.withGuild(guild, (tx) => eventsAfter(tx, 0, 500))
  return { a, guild, held, deps, types, gateStore }
}

test('Council approval on Postgres: the Quest is done as council_approved and the chain never records a Guild Master Seal', async () => {
  const w = await world()
  const result = await requestQuestSeal(w.deps, w.guild, w.held)
  expect(result.outcome).toBe('council_approved')
  const quest = await w.a.quests.get(w.guild, w.held.id)
  expect(quest).toMatchObject({ state: 'done', lastError: 'council_approved' })
  const seal = await w.a.sealStore.forQuest(w.guild, w.held.id)
  expect(seal).toMatchObject({ status: 'council_approved', decidedBy: null })
  const events = await w.types()
  const names = events.map((e) => e.type)
  expect(names).toContain('council.approved')
  expect(names).toContain('seal.council_approved')
  for (const guildMasterEvent of [
    'seal.approved',
    'seal.denied',
    'seal.reserved',
    'seal.consumed',
    'post.published_manually',
  ]) {
    expect(names).not.toContain(guildMasterEvent)
  }
  const sealEvent = events.find((e) => e.type === 'seal.council_approved')
  expect(sealEvent?.payload).toMatchObject({ sessionId: seal?.councilSessionId })
  expect(JSON.stringify(sealEvent?.payload)).not.toContain('decidedBy')
})

test('Bar the Gates on Postgres: a barred guild never approves, council.halted is recorded and the Quest stays Awaiting Seal', async () => {
  const w = await world()
  await w.gateStore.bar({ guildId: w.guild, memberId: crypto.randomUUID() }, 'guild')
  for (let pass = 0; pass < 3; pass += 1) {
    expect((await requestQuestSeal(w.deps, w.guild, w.held)).outcome).toBe('council_pending')
  }
  expect((await w.a.quests.get(w.guild, w.held.id))?.state).toBe('awaiting_seal')
  expect(await w.a.sealStore.forQuest(w.guild, w.held.id)).toBeNull()
  const names = (await w.types()).map((e) => e.type)
  expect(names.filter((n) => n === 'council.halted')).toHaveLength(1)
  expect(names).not.toContain('council.approved')
})

test('the Guild Master returning during the vote on Postgres: no council.approved, no approval row, a normal Seal', async () => {
  const w = await world()
  await w.a.presence.returnHome(w.guild)
  const away = await w.a.presence.goAway(w.guild, null)
  expect(away.away).toBe(true)
  const council = new CouncilEngine({
    store: w.a.councilStore,
    model: new ScriptedCouncilModel(async (call) => {
      if (call.system.includes('user voice')) {
        await w.a.presence.returnHome(w.guild)
      }
      return voteReply('approve', 'fine')
    }),
    clock: w.a.clock,
    gates: w.gateStore,
    config: w.a.config,
    presence: w.a.presence,
  })
  const result = await requestQuestSeal({ ...w.deps, council }, w.guild, w.held)
  expect(result.outcome).toBe('requested')
  expect((await w.a.sealStore.forQuest(w.guild, w.held.id))?.status).toBe('requested')
  expect((await w.types()).map((e) => e.type)).not.toContain('council.approved')
  expect(await w.a.councilStore.approvalsToday(w.guild, '2026-01-01', 'x')).toBe(0)
})
