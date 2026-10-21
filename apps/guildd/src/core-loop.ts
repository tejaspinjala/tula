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
          seal.status === 'consumed' || seal.status === 'council_approved'
            ? 'posted'
            : seal.status === 'denied' || seal.status === 'expired'
              ? 'rejected'
              : null
        if (outcome !== null) {
          await deps.quests.settleSeal(guildId, quest.id, outcome, {
            round: seal.round,
            ...(seal.status === 'council_approved' ? { reason: 'council_approved' as const } : {}),
          })
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
  sealStore: Pick<SealStore, 'forQuest' | 'councilApprove'>
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
  council?: Pick<CouncilEngine, 'convene' | 'approve' | 'approvalsRemaining' | 'approvedSession'>
  /** The instant "away" is judged at. Absent: the Council never convenes. */
  clock?: Pick<Clock, 'now'>
}

/** What consulting the Council came to: nothing, not yet, evidence for a Seal, or an approval. */
type CouncilConsult =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'evidence'; evidence: string }
  | { kind: 'approved'; sessionId: string; evidence: string }

/**
 * Convenes the Council of Elders when, and only when, all of these hold, each decided by code:
 * the Seal Policy is `routine_alone`, the Guild Master is away, the Proposal is routine and the
 * guild is under its daily sessions cap. Five approvals while approvals remain end in approval in
 * place of a Seal, decided per Quest: isRoutine and the daily cap (this Quest's own earlier
 * approval aside) are re-read after the vote and Bar the Gates is re-read immediately before the
 * approval. Anything else returns the Council's votes as evidence on the Seal that is requested.
 */
async function consultCouncil(
  deps: SealRequestDeps,
  guildId: string,
  quest: Quest,
  proposal: { hash: string; content: string },
  verdict: Verdict
): Promise<CouncilConsult> {
  if (!deps.config) {
    return { kind: 'none' }
  }
  const { config: config0 } = await deps.config.current(guildId)
  const { council, presence, clock } = deps
  if (config0.sealPolicy !== 'routine_alone' || !presence || !council || !clock) {
    return { kind: 'none' }
  }
  if (!isAway(await presence.get(guildId), clock.now())) {
    return { kind: 'none' }
  }
  const template = QUEST_TEMPLATES.find((t) => t.id === quest.templateId)
  const configs = deps.config
  /** Routine now, on freshly read config; this Quest's own approval never counts against it. */
  const routineNow = async (): Promise<{ routine: boolean; cap: number }> => {
    const cap = councilApprovalCap((await configs.current(guildId)).config)
    return {
      cap,
      routine: isRoutine({
        templateRoutineEligible: template?.routineEligible === true,
        dataClass: quest.dataClass,
        proposalHash: proposal.hash,
        verdict,
        approvalsRemainingToday: await council.approvalsRemaining(guildId, quest.id, cap),
      }),
    }
  }
  if (!(await routineNow()).routine) {
    return { kind: 'none' }
  }
  const result = await council.convene(guildId, {
    quest,
    proposal,
    sessionCap: councilSessionCap(config0),
    approvalCap: councilApprovalCap(config0),
  })
  if (result.status === 'in_progress') {
    return { kind: 'pending' }
  }
  if (result.status === 'cap_reached') {
    return { kind: 'none' }
  }
  if (result.status === 'escalated') {
    return { kind: 'evidence', evidence: councilEvidence(result.votes, result.reason) }
  }
  // Unanimous: re-check for this Quest alone before it settles.
  const now = await routineNow()
  if (!now.routine) {
    return { kind: 'evidence', evidence: councilEvidence(result.votes, 'not_routine') }
  }
  const settled = await council.approve(guildId, {
    session: result.session,
    questId: quest.id,
    cap: now.cap,
  })
  if (settled === 'halted') {
    return { kind: 'pending' }
  }
  if (settled !== 'approved') {
    // The cap was spent, the Guild Master is back, the policy changed or the session closed: the
    // Proposal takes the normal Seal, with the votes as evidence.
    const why = {
      cap_reached: 'approval_cap',
      not_allowed: 'not_allowed',
      not_found: 'session_closed',
    } as const
    return { kind: 'evidence', evidence: councilEvidence(result.votes, why[settled]) }
  }
  return {
    kind: 'approved',
    sessionId: result.session.id,
    evidence: councilEvidence(result.votes, 'approved'),
  }
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
  const consult = await consultCouncil(deps, guildId, quest, proposal, verdict)
  if (consult.kind === 'pending') {
    return { outcome: 'council_pending' }
  }
  const seal = await deps.seals.requestSeal(guildId, {
    questId: quest.id,
    requestedBy: quest.ownerId,
    kind: proposal.kind,
    text: proposal.content,
    evidence: consult.kind === 'none' ? verdictEvidence : `${verdictEvidence}; ${consult.evidence}`,
    round: quest.round,
  })
  if (consult.kind === 'approved') {
    // The Council approved in the Guild Master's absence: the request settles as council_approved
    // (naming the session, never a member) and the Quest finishes. A crash between the steps is
    // safe: the approval row, the Seal request and both settlements are each idempotent.
    const approved = await deps.sealStore.councilApprove(guildId, seal.id, {
      sessionId: consult.sessionId,
      expectedHash: proposal.hash,
    })
    if (approved.ok) {
      return {
        outcome: 'council_approved',
        seal: approved.seal,
        quest: await deps.quests.settleSeal(guildId, quest.id, 'posted', {
          round: quest.round,
          reason: 'council_approved',
        }),
      }
    }
  }
  return { outcome: 'requested', seal }
}

/**
 * Finishes a Council approval a crash (or a refused settlement) left half done: a `requested` Seal
 * whose Quest already holds a Council approval on exactly the sealed hash is settled as
 * `council_approved` and its Quest finished. The approval was already counted, so nothing more is
 * consumed. Each step is idempotent; a Quest that fails is logged (ids only) and skipped.
 */
async function healCouncilApprovals(deps: PendingSealDeps, guildId: string): Promise<void> {
  const { council, config, presence, clock } = deps
  if (!council || !config || !presence || !clock) {
    return
  }
  // A recorded approval is final for the cap, not for the Seal: settle only while the Council
  // could still approve (policy `routine_alone` and the Guild Master away); else the Seal stays
  // requested for the Guild Master.
  if (
    (await config.current(guildId)).config.sealPolicy !== 'routine_alone' ||
    !isAway(await presence.get(guildId), clock.now())
  ) {
    return
  }
  let after: string | undefined
  do {
    const page = await deps.sealStore.list(guildId, {
      limit: 100,
      status: 'requested',
      ...(after === undefined ? {} : { after }),
    })
    for (const seal of page.seals) {
      try {
        const sessionId = await council.approvedSession(guildId, seal.questId, seal.actionHash)
        if (sessionId === null) {
          continue
        }
        const approved = await deps.sealStore.councilApprove(guildId, seal.id, {
          sessionId,
          expectedHash: seal.actionHash,
        })
        if (approved.ok) {
          await deps.quests.settleSeal(guildId, seal.questId, 'posted', {
            round: seal.round,
            reason: 'council_approved',
          })
        }
      } catch (error) {
        logPassFailure('heal', guildId, seal.questId, error)
      }
    }
    after = page.next ?? undefined
  } while (after !== undefined)
}

/** Collaborators of {@link requestPendingSeals}. */
export interface PendingSealDeps extends SealRequestDeps {
  quests: Pick<QuestQueue, 'settleSeal'>
  sealStore: Pick<SealStore, 'forQuest' | 'councilApprove' | 'expireDue' | 'list'>
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
  await healCouncilApprovals(deps, guildId)
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
