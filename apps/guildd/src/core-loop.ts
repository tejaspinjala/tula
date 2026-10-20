import type { Quest, QuestQueue } from './ports/quest-queue'
import type { Seal, SealStore } from './ports/seal-store'
import type { ProposalEngine } from './proposals'
import type { SealEngine } from './seals'

/** Collaborators of {@link reconcileSeals}. */
export interface CoreLoopDeps {
  quests: QuestQueue
  seals: Pick<SealStore, 'forQuest'>
}

/**
 * Settles every Quest of the guild held in `awaiting_seal` whose Seal for the Quest's current
 * round has ended: consumed or posted finishes it; denied or expired sends it to a revision round
 * or the dead letters (see `QuestQueue.settleSeal`). Deterministic and keyed by quest id, so
 * a rerun, or two workers at once, change nothing. Returns how many Quests it settled.
 */
export async function reconcileSeals(
  deps: CoreLoopDeps,
  guildId: string
): Promise<{ settled: number }> {
  let settled = 0
  let after: string | undefined
  do {
    const page = await deps.quests.list(guildId, {
      limit: 100,
      state: 'awaiting_seal',
      ...(after === undefined ? {} : { after }),
    })
    for (const quest of page.quests) {
      const seal = await deps.seals.forQuest(guildId, quest.id)
      if (!seal || seal.round !== quest.round) {
        continue
      }
      const outcome =
        seal.status === 'consumed'
          ? 'posted'
          : seal.status === 'denied' || seal.status === 'expired'
            ? 'rejected'
            : null
      if (outcome !== null) {
        await deps.quests.settleSeal(guildId, quest.id, outcome)
        settled += 1
      }
    }
    after = page.next ?? undefined
  } while (after !== undefined)
  return { settled }
}

/** Collaborators of {@link requestQuestSeal}. */
export interface SealRequestDeps {
  quests: Pick<QuestQueue, 'settleSeal'>
  proposals: Pick<ProposalEngine, 'latestForQuest' | 'verdictFor'>
  seals: Pick<SealEngine, 'requestSeal'>
}

/** What {@link requestQuestSeal} did: asked for a Seal, rejected the Proposal, or found none. */
export type QuestSealOutcome =
  | { outcome: 'requested'; seal: Seal }
  | { outcome: 'rejected'; quest: Quest }
  | { outcome: 'no_proposal' }

/**
 * Asks for the Seal of a Quest held in `awaiting_seal`, gated on the Verdict bound to the hash of
 * its latest Proposal. Passed: the Seal is requested for exactly that text and the Quest's round.
 * Failed: the Quest is settled as rejected (a revision round, or the dead letters). Deterministic.
 */
export async function requestQuestSeal(
  deps: SealRequestDeps,
  guildId: string,
  quest: Quest
): Promise<QuestSealOutcome> {
  const proposal = await deps.proposals.latestForQuest(guildId, quest.id)
  if (!proposal) {
    return { outcome: 'no_proposal' }
  }
  const verdict = await deps.proposals.verdictFor(guildId, proposal.hash)
  if (!verdict?.passed) {
    return {
      outcome: 'rejected',
      quest: await deps.quests.settleSeal(guildId, quest.id, 'rejected'),
    }
  }
  const seal = await deps.seals.requestSeal(guildId, {
    questId: quest.id,
    requestedBy: quest.ownerId,
    kind: proposal.kind,
    text: proposal.content,
    evidence: `Verdict passed: ${verdict.findings.map((f) => `${f.check} (${f.detail})`).join('; ')}`,
    round: quest.round,
  })
  return { outcome: 'requested', seal }
}
