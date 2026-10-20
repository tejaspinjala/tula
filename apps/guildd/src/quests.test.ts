import { expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { defaultConfig } from './guild-config'
import { postQuest, QUEST_TEMPLATES } from './quests'

async function setup() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const queue = new MemoryQuestQueue(clock, () => 0.5)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  return { config, queue, guild }
}

test('posting from a template takes its Hall, rank and data class, and a Member of that rank owns it', async () => {
  const { config, queue, guild } = await setup()
  const template = QUEST_TEMPLATES.find((t) => t.id === 'herald-brief')
  const result = await postQuest({ config, queue }, guild, {
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
  const { config, queue, guild } = await setup()
  const base = defaultConfig()
  const halls = base.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h))
  await config.propose(guild, { ...base, halls })
  const result = await postQuest({ config, queue }, guild, {
    templateId: 'herald-brief',
    jobKey: 'brief-1',
    title: 'Brief',
  })
  expect(result).toEqual({ ok: false, error: 'hall_locked' })
  expect((await queue.list(guild, { limit: 10 })).quests).toEqual([])
})

test('an unknown template or an owner outside the Hall is refused', async () => {
  const { config, queue, guild } = await setup()
  const deps = { config, queue }
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
  const { config, queue, guild } = await setup()
  const result = await postQuest({ config, queue }, guild, {
    templateId: 'herald-brief',
    jobKey: 'k',
    title: 'T',
    blockedBy: [crypto.randomUUID()],
  })
  expect(result).toEqual({ ok: false, error: 'unknown_blocker' })
})
