import { type CouncilEngine, councilEvidence } from './council'
import { councilApprovalCap, councilSessionCap } from './guild-config'
import { GatewayError } from './model-gateway'
import type { AwaitingSealReader } from './ports/awaiting-seal-reader'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import { isAway, type PresenceStore } from './ports/presence-store'
import type { Verdict } from './ports/proposal-store'
import type { Quest, QuestQueue } from './ports/quest-queue'
import type { Seal, SealStore } from './ports/seal-store'
import type { ProposalEngine } from './proposals'
import { QUEST_TEMPLATES } from './quests'
import { isRoutine } from './routine'
import { type SealEngine, SealRequestError } from './seals'

/** One stderr line naming the failed step and the ids, never the error text. */
function logPassFailure(step: string, guildId: string, questId: string, error: unknown): void {
  const name = error instanceof Error ? error.name : 'unknown'
  const code = error instanceof GatewayError ? ` code=${error.code}` : ''
  process.stderr.write(`seal ${step} failed: guild=${guildId} quest=${questId} ${name}${code}\n`)
}

/** Dead-letters a Quest whose Seal can never be requested, isolating a failure of that too. */
async function settleDead(
  deps: Pick<PendingSealDeps, 'quests'>,
  guildId: string,
  quest: Quest
): Promise<void> {
  try {
    await deps.quests.settleSeal(guildId, quest.id, 'rejected', {
      terminal: true,
      reason: 'requester_reserved',
      round: quest.round,
    })
  } catch (error) {
    logPassFailure('dead-letter', guildId, quest.id, error)
  }
}

/** Collaborators of {@link reconcileSeals}. */
export interface CoreLoopDeps {
  quests: Pick<QuestQueue, 'settleSeal'>
  seals: Pick<SealStore, 'expireDue'>
  awaiting: AwaitingSealReader
}

/** Hours an approved Seal may wait to be posted when the caller passes no window (72). */
const DEFAULT_POST_WINDOW_MS = 72 * 3_600_000

/**
 * Settles every Quest of the guild held in `awaiting_seal` whose Seal for the Quest's current
 * round has ended: consumed or posted finishes it; denied or expired sends it to a revision round
 * or the dead letters (see `QuestQueue.settleSeal`). Deterministic and keyed by quest id, so
 * a rerun, or two workers at once, change nothing. First expires approved Seals never posted
 * within `postWindowMs` (the guild's `caps.sealPostWindowHours`), so their Quests are freed.
 * Returns how many Quests it settled.
 */
export async function reconcileSeals(
  deps: CoreLoopDeps,
  guildId: string,
  postWindowMs: number = DEFAULT_POST_WINDOW_MS
): Promise<{ settled: number }> {
  await deps.seals.expireDue(guildId, { approvedWindowMs: postWindowMs })
  let settled = 0
  if (!(await deps.awaiting.hasWork(guildId))) {
    return { settled }
  }
  let after: string | undefined
  do {
    const page = await deps.awaiting.due(guildId, {
      limit: 100,
      ...(after === undefined ? {} : { after }),
    })
    for (const { quest, seal } of page.items) {
      try {
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
          await deps.quests.settleSeal(guildId, quest.id, outcome, { round: seal.round })
          settled += 1
        }
      } catch (error) {
        logPassFailure('reconcile', guildId, quest.id, error)
      }
    }
    after = page.next ?? undefined
  } while (after !== undefined)
  return { settled }
}

/** Collaborators of {@link requestQuestSeal}. */
export interface SealRequestDeps {
  quests: Pick<QuestQueue, 'settleSeal'>
  sealStore: Pick<SealStore, 'forQuest'>
  proposals: Pick<ProposalEngine, 'latestForQuest' | 'verdictFor'>
  seals: Pick<SealEngine, 'requestSeal'>
  /**
   * Read at request time for the guild's Seal Policy and Council caps. Absent means `always`: the
   * Council never convenes without it.
   */
  config?: Pick<ConfigStore, 'current'>
  /** Whether the Guild Master is away (read at request time, never cached). Absent: never away. */
  presence?: Pick<PresenceStore, 'get'>
  /** The Council of Elders. Absent: it never convenes. */
  council?: Pick<CouncilEngine, 'convene'>
  /** The instant "away" is judged at. Absent: the Council never convenes. */
  clock?: Pick<Clock, 'now'>
}

/**
 * Convenes the Council of Elders when, and only when, all of these hold, each decided by code:
 * the Seal Policy is `routine_alone`, the Guild Master is away, the Proposal is routine and the
 * guild is under its daily sessions cap. Returns the Council's votes as Seal evidence, or null
 * when it did not convene. The outcome is always escalation to the Guild Master's Seal in this
 * release, so the Seal is requested either way; approval in place of a Seal comes later (#150).
 */
async function consultCouncil(
  deps: SealRequestDeps,
  guildId: string,
  quest: Quest,
  proposal: { hash: string; content: string },
  verdict: Verdict
): Promise<string | 'pending' | null> {
  if (!deps.config) {
    return null
  }
  const { config } = await deps.config.current(guildId)
  if (config.sealPolicy !== 'routine_alone' || !deps.presence || !deps.council || !deps.clock) {
    return null
  }
  if (!isAway(await deps.presence.get(guildId), deps.clock.now())) {
    return null
  }
  const template = QUEST_TEMPLATES.find((t) => t.id === quest.templateId)
  const routine = isRoutine({
    templateRoutineEligible: template?.routineEligible === true,
    dataClass: quest.dataClass,
    proposalHash: proposal.hash,
    verdict,
    // The Council gives no approvals yet, so the whole daily allowance remains.
    approvalsRemainingToday: councilApprovalCap(config),
  })
  if (!routine) {
    return null
  }
  const result = await deps.council.convene(guildId, {
    quest,
    proposal,
    sessionCap: councilSessionCap(config),
    approvalCap: councilApprovalCap(config),
  })
  if (result.status === 'in_progress') {
    return 'pending'
  }
  return result.status === 'escalated' ? councilEvidence(result.votes, result.reason) : null
}

/** What {@link requestQuestSeal} did: asked for a Seal, rejected the Proposal, or found none. */
export type QuestSealOutcome =
  | { outcome: 'requested'; seal: Seal }
  | { outcome: 'rejected'; quest: Quest }
  | { outcome: 'no_proposal' }
  /** The Council of Elders approved in the Guild Master's absence: the Seal is `council_approved` and the Quest is done. */
  | { outcome: 'council_approved'; seal: Seal; quest: Quest }
  /** The Council is mid-session on another worker: not yet; no Seal is requested this pass. */
  | { outcome: 'council_pending' }

/**
 * Asks for the Seal of a Quest held in `awaiting_seal`, gated on the Verdict bound to the hash of
 * its latest Proposal. Passed: the Seal is requested for exactly that text and the Quest's round.
 * Failed: the Quest is settled as rejected (a revision round, or the dead letters). A revision
 * round whose latest Proposal is still the text the previous round's Seal bound is settled
 * rejected as `no_revision`, so a denied hash is never asked for twice. Deterministic.
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
  // The previous round's Seal already bound this exact text: no new Proposal followed the denial
  // (or expiry), so there is nothing new to ask a Seal for. Compared by hash, not by clock, so two
  // writes in one instant cannot be mistaken for a revision.
  const previous = await deps.sealStore.forQuest(guildId, quest.id)
  if (previous && previous.round < quest.round && proposal.hash === previous.actionHash) {
    return {
      outcome: 'rejected',
      quest: await deps.quests.settleSeal(guildId, quest.id, 'rejected', { reason: 'no_revision' }),
    }
  }
  const verdict = await deps.proposals.verdictFor(guildId, proposal.hash)
  if (!verdict?.passed) {
    return {
      outcome: 'rejected',
      quest: await deps.quests.settleSeal(guildId, quest.id, 'rejected'),
    }
  }
  const verdictEvidence = `Verdict passed: ${verdict.findings.map((f) => `${f.check} (${f.detail})`).join('; ')}`
  const council = await consultCouncil(deps, guildId, quest, proposal, verdict)
  if (council === 'pending') {
    return { outcome: 'council_pending' }
  }
  const seal = await deps.seals.requestSeal(guildId, {
    questId: quest.id,
    requestedBy: quest.ownerId,
    kind: proposal.kind,
    text: proposal.content,
    evidence: council === null ? verdictEvidence : `${verdictEvidence}; ${council}`,
    round: quest.round,
  })
  return { outcome: 'requested', seal }
}

/** Collaborators of {@link requestPendingSeals}. */
export interface PendingSealDeps extends SealRequestDeps {
  quests: Pick<QuestQueue, 'settleSeal'>
  sealStore: Pick<SealStore, 'forQuest' | 'expireDue'>
  awaiting: AwaitingSealReader
}

/**
 * Requests the Seal of every `awaiting_seal` Quest of the guild that has none for its current
 * round (see {@link requestQuestSeal}). Quests already holding a Seal for this round are skipped,
 * so a rerun asks for nothing twice. A Quest that fails is logged (ids only) and skipped, so one
 * poisoned Quest never stops the rest; one whose requester is refused is dead-lettered. Returns
 * how many Seals it requested.
 */
export async function requestPendingSeals(
  deps: PendingSealDeps,
  guildId: string
): Promise<{ requested: number }> {
  let requested = 0
  if (!(await deps.awaiting.hasWork(guildId))) {
    return { requested }
  }
  let after: string | undefined
  do {
    const page = await deps.awaiting.due(guildId, {
      limit: 100,
      ...(after === undefined ? {} : { after }),
    })
    for (const { quest, seal } of page.items) {
      try {
        if (seal && seal.round === quest.round) {
          // Its Seal ended: reconcile settles it; there is nothing to ask for.
          continue
        }
        if ((await requestQuestSeal(deps, guildId, quest)).outcome === 'requested') {
          requested += 1
        }
      } catch (error) {
        if (error instanceof SealRequestError) {
          // The Quest's owner may never request a Seal: retrying cannot help, so dead-letter it.
          await settleDead(deps, guildId, quest)
        } else {
          logPassFailure('request', guildId, quest.id, error)
        }
      }
    }
    after = page.next ?? undefined
  } while (after !== undefined)
  return { requested }
}
