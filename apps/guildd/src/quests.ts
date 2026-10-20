import { z } from 'zod'
import { type GuildConfig, hallAcceptsQuests } from './guild-config'
import type { ConfigStore } from './ports/config-store'
import {
  type DataClass,
  type Quest,
  QuestError,
  type QuestQueue,
  type questRank,
  newQuest as queueQuest,
} from './ports/quest-queue'

/** A Quest template: the Hall, rank, data class, done-condition and round limit a Quest is posted with. */
export interface QuestTemplate {
  id: string
  name: string
  hallId: string
  rank: z.infer<typeof questRank>
  dataClass: DataClass
  doneCondition: string
  roundLimit: number
}

/** The Quest templates the Guild Master can post from. Code, not model output. */
export const QUEST_TEMPLATES: readonly QuestTemplate[] = [
  {
    id: 'herald-brief',
    name: 'Herald brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    doneCondition: 'A draft brief is filed in the Archive',
    roundLimit: 2,
  },
  {
    id: 'herald-announcement',
    name: 'Herald announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    doneCondition: 'An announcement draft is ready for a Seal',
    roundLimit: 3,
  },
]

/** What the Guild Master supplies when posting a Quest from a template. */
export const postQuestInput = z.object({
  templateId: z.string().min(1).max(64),
  jobKey: queueQuest.shape.jobKey,
  title: queueQuest.shape.title,
  campaignId: queueQuest.shape.campaignId,
  blockedBy: queueQuest.shape.blockedBy,
  /** Defaults to a Member of the template's rank in the Hall, else the Hall's Captain. */
  ownerId: z.string().min(1).max(64).optional(),
  doneCondition: queueQuest.shape.doneCondition.optional(),
})
/** Input to {@link postQuest}. */
export type PostQuestInput = z.input<typeof postQuestInput>

/** Why a Quest could not be posted. */
export type PostQuestError =
  | 'unknown_template'
  | 'hall_locked'
  | 'hall_not_found'
  | 'unknown_owner'
  | 'unknown_blocker'

/** The outcome of {@link postQuest}. */
export type PostQuestResult =
  | { ok: true; quest: Quest; created: boolean }
  | { ok: false; error: PostQuestError }

function chooseOwner(
  config: GuildConfig,
  template: QuestTemplate,
  requested: string | undefined
): string | null {
  const hall = config.halls.find((h) => h.id === template.hallId)
  if (!hall) {
    return null
  }
  const people = [...(hall.captain ? [hall.captain.id] : []), ...hall.members.map((m) => m.id)]
  if (requested !== undefined) {
    return people.includes(requested) ? requested : null
  }
  const ranked = hall.members.find((m) => m.rank === template.rank)
  return ranked?.id ?? hall.captain?.id ?? null
}

/**
 * Posts a Quest from a template. The Hall, rank and data class come from the template; the guild
 * config (current version) decides whether the Hall is locked and who may own the Quest.
 */
export async function postQuest(
  deps: { config: ConfigStore; queue: QuestQueue },
  guildId: string,
  input: PostQuestInput
): Promise<PostQuestResult> {
  const template = QUEST_TEMPLATES.find((t) => t.id === input.templateId)
  if (!template) {
    return { ok: false, error: 'unknown_template' }
  }
  const { config } = await deps.config.current(guildId)
  const accepts = hallAcceptsQuests(config, template.hallId)
  if (!accepts.ok) {
    return { ok: false, error: accepts.error }
  }
  const ownerId = chooseOwner(config, template, input.ownerId)
  if (ownerId === null) {
    return { ok: false, error: 'unknown_owner' }
  }
  try {
    const { quest, created } = await deps.queue.post(guildId, {
      jobKey: input.jobKey,
      ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
      templateId: template.id,
      hallId: template.hallId,
      rank: template.rank,
      dataClass: template.dataClass,
      title: input.title,
      ownerId,
      doneCondition: input.doneCondition ?? template.doneCondition,
      roundLimit: template.roundLimit,
      blockedBy: input.blockedBy ?? [],
    })
    return { ok: true, quest, created }
  } catch (error) {
    if (error instanceof QuestError && error.code === 'unknown_blocker') {
      return { ok: false, error: 'unknown_blocker' }
    }
    throw error
  }
}
