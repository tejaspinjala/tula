import { assembleDossier, citedArtifacts, type DossierSeal, type DossierVerdict } from './dossier'
import type { Clock } from './ports/clock'
import type { Dossier, DossierRequester, DossierStore } from './ports/dossier-store'
import type { HandoffStore } from './ports/handoff-store'
import { hashBytes, type ObjectStore } from './ports/object-store'
import type { ProposalStore } from './ports/proposal-store'
import type { QuestQueue } from './ports/quest-queue'
import type { SealStore } from './ports/seal-store'

/** Ports the {@link DossierService} reads the subject Quest's records from. */
export interface DossierServiceDeps {
  quests: Pick<QuestQueue, 'get'>
  handoffs: Pick<HandoffStore, 'get'>
  objectStore: Pick<ObjectStore, 'get'>
  proposals: Pick<ProposalStore, 'latestForQuest'>
  seals: Pick<SealStore, 'forQuest'>
  store: Pick<DossierStore, 'create' | 'countForQuest'>
  clock: Clock
}

/** Why a Dossier could not be made. */
export type DossierRefusal =
  | 'unknown_quest'
  | 'quest_not_finished'
  | 'dossier_cap'
  | 'private_boundary'

/** The outcome of {@link DossierService.request}. */
export type DossierOutcome = { ok: true; dossier: Dossier } | { ok: false; error: DossierRefusal }

/**
 * Makes Dossiers: reads the subject Quest's stored records, re-checks the Handoff and every
 * cited artifact against the ObjectStore, and stores the result. Pure code over stored records;
 * no model is called. Who may ask, and the private boundary, are the caller's rule.
 */
export class DossierService {
  constructor(private readonly deps: DossierServiceDeps) {}

  /**
   * Builds and stores a Dossier about `questId`. `unknown_quest` when the guild has no such
   * Quest. `quest_not_finished` unless the Quest is `done` (the final state: its Seal, if any,
   * was settled) with a Handoff recorded for the attempt that finished it; a Quest that is
   * queued again, active, awaiting its Seal or dead is not finished. `dossier_cap` when a
   * Member's Quest has used its allowance (`maxPerQuest`; the Guild Master has none), checked
   * before any artifact is read (the store's atomic check stays authoritative).
   * `private_boundary` when the Quest is private-class and a Member requester is not inside the
   * private boundary (`mayReadPrivate`, set for a private Hall or a private-class Quest); the
   * Guild Master is never refused. The gateway's cross-Hall rule is the first check; this is the
   * second, so no caller can build a private Dossier by forgetting it.
   */
  async request(
    guildId: string,
    questId: string,
    requester: DossierRequester,
    maxPerQuest?: number,
    mayReadPrivate = false
  ): Promise<DossierOutcome> {
    const quest = await this.deps.quests.get(guildId, questId)
    if (!quest) {
      return { ok: false, error: 'unknown_quest' }
    }
    if (quest.dataClass === 'private' && requester.kind === 'member' && !mayReadPrivate) {
      return { ok: false, error: 'private_boundary' }
    }
    if (quest.state !== 'done') {
      return { ok: false, error: 'quest_not_finished' }
    }
    const stored = await this.deps.handoffs.get(guildId, quest.id, quest.attempts)
    if (!stored) {
      return { ok: false, error: 'quest_not_finished' }
    }
    if (
      maxPerQuest !== undefined &&
      requester.kind === 'member' &&
      (await this.deps.store.countForQuest(guildId, requester.questId)) >= maxPerQuest
    ) {
      return { ok: false, error: 'dossier_cap' }
    }
    const observed = new Map<string, { actualHash: string; size: number } | null>()
    for (const hash of citedArtifacts(stored.handoff)) {
      const bytes = await this.deps.objectStore.get(guildId, hash)
      observed.set(hash, bytes ? { actualHash: hashBytes(bytes), size: bytes.length } : null)
    }
    const assembled = assembleDossier(
      {
        questId: quest.id,
        hallId: quest.hallId,
        handoff: stored.handoff,
        handoffHash: stored.hash,
        verdict: await this.verdictOf(guildId, quest.id),
        seal: await this.sealOf(guildId, quest.id),
      },
      observed
    )
    const made = await this.deps.store.create(guildId, {
      subjectQuestId: quest.id,
      subjectHallId: quest.hallId,
      requester,
      body: assembled.body,
      hash: assembled.hash,
      verified: assembled.verified,
      failedChecks: assembled.failedChecks,
      ...(maxPerQuest === undefined ? {} : { maxPerQuest }),
      at: this.deps.clock.now(),
    })
    return made
  }

  private async verdictOf(guildId: string, questId: string): Promise<DossierVerdict | null> {
    const proposal = await this.deps.proposals.latestForQuest(guildId, questId)
    return proposal
      ? {
          proposalHash: proposal.verdict.proposalHash,
          passed: proposal.verdict.passed,
          findingCount: proposal.verdict.findings.length,
        }
      : null
  }

  private async sealOf(guildId: string, questId: string): Promise<DossierSeal | null> {
    const seal = await this.deps.seals.forQuest(guildId, questId)
    return seal ? { status: seal.status, actionHash: seal.actionHash } : null
  }
}
