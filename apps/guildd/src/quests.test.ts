import { expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemoryTripwireStore } from './adapters/memory-tripwire-store'
import { defaultConfig } from './guild-config'
import { FIX_QUEST_TEMPLATE, postQuest, QUEST_TEMPLATES } from './quests'
import { SUMMON_TEMPLATE_ID } from './summon'

async function setup() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const queue = new MemoryQuestQueue(clock, () => 0.5)
  const tripwires = new MemoryTripwireStore(clock)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  return { config, queue, tripwires, guild }
}

test('posting from a template takes its Hall, rank and data class, and a Member of that rank owns it', async () => {
  const { config, queue, tripwires, guild } = await setup()
  const template = QUEST_TEMPLATES.find((t) => t.id === 'herald-brief')
  const result = await postQuest({ config, queue, tripwires }, guild, {
    templateId: 'herald-brief',
    jobKey: 'brief-1',
    title: 'Brief for launch',
  })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    return
  }
  expect(result.quest).toMatchObject({
    hallId: template?.hallId,
    rank: template?.rank,
    dataClass: template?.dataClass,
    ownerId: 'heralds-member-2',
    doneCondition: template?.doneCondition,
    roundLimit: template?.roundLimit,
  })
})

test('a locked Hall rejects Quests', async () => {
  const { config, queue, tripwires, guild } = await setup()
  const base = defaultConfig()
  const halls = base.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h))
  await config.propose(guild, { ...base, halls })
  const result = await postQuest({ config, queue, tripwires }, guild, {
    templateId: 'herald-brief',
    jobKey: 'brief-1',
    title: 'Brief',
  })
  expect(result).toEqual({ ok: false, error: 'hall_locked' })
  expect((await queue.list(guild, { limit: 10 })).quests).toEqual([])
})

test('an unknown template or an owner outside the Hall is refused', async () => {
  const { config, queue, tripwires, guild } = await setup()
  const deps = { config, queue, tripwires }
  expect(await postQuest(deps, guild, { templateId: 'nope', jobKey: 'k', title: 'T' })).toEqual({
    ok: false,
    error: 'unknown_template',
  })
  expect(
    await postQuest(deps, guild, {
      templateId: 'herald-brief',
      jobKey: 'k',
      title: 'T',
      ownerId: 'stranger',
    })
  ).toEqual({ ok: false, error: 'unknown_owner' })
})

test('a blocker that is not a Quest of this guild is refused', async () => {
  const { config, queue, tripwires, guild } = await setup()
  const result = await postQuest({ config, queue, tripwires }, guild, {
    templateId: 'herald-brief',
    jobKey: 'k',
    title: 'T',
    blockedBy: [crypto.randomUUID()],
  })
  expect(result).toEqual({ ok: false, error: 'unknown_blocker' })
})

test('a paused Hall rejects Quests until it resumes, and a locked Hall still reads locked', async () => {
  const { config, queue, tripwires, guild } = await setup()
  await tripwires.pause(guild, { hallId: 'heralds', tripwire: 'loop', observed: 5, threshold: 5 })
  const input = { templateId: 'herald-brief', jobKey: 'brief-p', title: 'Brief' }
  expect(await postQuest({ config, queue, tripwires }, guild, input)).toEqual({
    ok: false,
    error: 'hall_paused',
  })
  await tripwires.resume(guild, 'heralds')
  expect((await postQuest({ config, queue, tripwires }, guild, input)).ok).toBe(true)
})

test('the Summon test Quest is posted from a template whose done-condition needs no Seal', () => {
  const template = QUEST_TEMPLATES.find((t) => t.id === SUMMON_TEMPLATE_ID)
  expect(template?.requiresSeal).toBe(false)
  expect(QUEST_TEMPLATES.find((t) => t.id === 'herald-announcement')?.requiresSeal).toBe(true)
})

test('only the Herald announcement template is routine-eligible; internal templates and the Fix Quest are not', () => {
  const eligible = QUEST_TEMPLATES.filter((t) => t.routineEligible === true).map((t) => t.id)
  expect(eligible).toEqual(['herald-announcement'])
  expect(FIX_QUEST_TEMPLATE.routineEligible).not.toBe(true)
})

test('the inquiry-answer template is internal: the Guild Master cannot post it', async () => {
  const { config, queue, tripwires, guild } = await setup()
  expect(
    await postQuest({ config, queue, tripwires }, guild, {
      templateId: 'inquiry-answer',
      jobKey: 'k',
      title: 'T',
    })
  ).toEqual({ ok: false, error: 'unknown_template' })
  expect((await queue.list(guild, { limit: 10 })).quests).toEqual([])
})

const PRIVATE_TEMPLATES = [
  ['health-log', 'health'],
  ['personal-plan', 'personal'],
  ['relationship-note', 'relationships'],
] as const

test('the Health log, Personal plan and Relationship note templates are private, need no Seal, and each has its own private Hall', () => {
  for (const [id, hallId] of PRIVATE_TEMPLATES) {
    expect(QUEST_TEMPLATES.find((t) => t.id === id)).toMatchObject({
      hallId,
      dataClass: 'private',
      requiresSeal: false,
    })
  }
})

async function withHall(hallId: string, over: { locked: boolean; privateEligible: boolean }) {
  const s = await setup()
  const base = defaultConfig()
  const halls = base.halls.map((h) =>
    h.id === hallId
      ? {
          ...h,
          ...over,
          members: [{ id: `${hallId}-member`, name: 'M', rank: 'journeyman' as const }],
        }
      : h
  )
  const proposed = await s.config.propose(s.guild, { ...base, halls })
  if (proposed.status === 'pending') {
    await s.config.confirm(s.guild, proposed.version)
  }
  return s
}

test.each(PRIVATE_TEMPLATES)(
  'posting %s into its locked Hall is refused as hall_locked',
  async (templateId, hallId) => {
    const s = await withHall(hallId, { locked: true, privateEligible: true })
    const result = await postQuest(s, s.guild, { templateId, jobKey: 'k', title: 'T' })
    expect(result).toEqual({ ok: false, error: 'hall_locked' })
  }
)

test.each(PRIVATE_TEMPLATES)(
  'posting %s into an unlocked Hall that is not private-eligible is refused as hall_not_private_eligible',
  async (templateId, hallId) => {
    const s = await withHall(hallId, { locked: false, privateEligible: false })
    const result = await postQuest(s, s.guild, { templateId, jobKey: 'k', title: 'T' })
    expect(result).toEqual({ ok: false, error: 'hall_not_private_eligible' })
    expect((await s.queue.list(s.guild, { limit: 10 })).quests).toEqual([])
  }
)

test.each(PRIVATE_TEMPLATES)(
  'posting %s into its unlocked private-eligible Hall queues a private Quest owned by its Member',
  async (templateId, hallId) => {
    const s = await withHall(hallId, { locked: false, privateEligible: true })
    const result = await postQuest(s, s.guild, { templateId, jobKey: 'k', title: 'T' })
    expect(result.ok && result.quest).toMatchObject({
      hallId,
      dataClass: 'private',
      ownerId: `${hallId}-member`,
    })
  }
)
