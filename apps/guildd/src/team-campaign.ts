import { z } from 'zod'
import { hallAcceptsQuests } from './guild-config'
import type { ConfigStore } from './ports/config-store'
import { type Quest, type QuestQueue, newQuest as queueQuest } from './ports/quest-queue'
import type { TripwireStore } from './ports/tripwire-store'
import { QUEST_TEMPLATES } from './quests'

/** What the Guild Master supplies to start a team Campaign: the Hall, a Campaign id (the retry key) and the goal. */
export const startTeamCampaignInput = z.strictObject({
  hall: z.string().min(1).max(64),
  campaignId: queueQuest.shape.campaignId.unwrap(),
  goal: z.string().trim().min(1).max(1500),
  /** Quests that must be done before the Captain starts planning (a workflow node after other work). */
  blockedBy: queueQuest.shape.blockedBy.optional(),
})
/** Input to {@link startTeamCampaign}. */
export type StartTeamCampaignInput = z.infer<typeof startTeamCampaignInput>

/** Why a team Campaign could not start. */
export type StartTeamCampaignError =
  | 'hall_not_found'
  | 'hall_locked'
  | 'hall_paused'
  | 'no_captain'
  | 'unknown_template'

/** The outcome of {@link startTeamCampaign}. */
export type StartTeamCampaignResult =
  | { ok: true; quest: Quest; created: boolean }
  | { ok: false; error: StartTeamCampaignError }

/**
 * Starts a team Campaign: gives the Hall's Captain its goal as their first Quest, to plan the
 * Campaign and post its Quests to the Hall's Quest Board. The Quest goes through the normal queue,
 * dispatcher, caps and Bar the Gates, so the route adds no authority. Idempotent per Campaign id.
 */
export async function startTeamCampaign(
  deps: { config: ConfigStore; queue: QuestQueue; tripwires: TripwireStore },
  guildId: string,
  input: StartTeamCampaignInput
): Promise<StartTeamCampaignResult> {
  const template = QUEST_TEMPLATES.find((t) => t.id === 'team-plan')
  if (!template) {
    return { ok: false, error: 'unknown_template' }
  }
  const { config } = await deps.config.current(guildId)
  const accepts = hallAcceptsQuests(config, input.hall)
  if (!accepts.ok) {
    return { ok: false, error: accepts.error }
  }
  const captain = config.halls.find((h) => h.id === input.hall)?.captain
  if (!captain) {
    return { ok: false, error: 'no_captain' }
  }
  if (await deps.tripwires.isPaused(guildId, input.hall)) {
    return { ok: false, error: 'hall_paused' }
  }
  const { quest, created } = await deps.queue.post(guildId, {
    jobKey: `team:${input.campaignId}`,
    campaignId: input.campaignId,
    templateId: template.id,
    hallId: input.hall,
    rank: template.rank,
    dataClass: template.dataClass,
    title: `Plan the Campaign: ${input.goal}`.slice(0, 200),
    ownerId: captain.id,
    blockedBy: input.blockedBy ?? [],
    doneCondition: `${template.doneCondition}: ${input.goal}`,
    roundLimit: template.roundLimit,
  })
  return { ok: true, quest, created }
}
