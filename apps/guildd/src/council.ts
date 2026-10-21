import type { CouncilCall, CouncilReply } from './model-gateway'
import type { Clock } from './ports/clock'
import type { CouncilSession, CouncilStore, CouncilVoice, CouncilVote } from './ports/council-store'

/** What a voice returns once its output validated. */
export interface VoteOutput {
  vote: 'approve' | 'block' | 'abstain'
  reasons: string[]
}

/** The model call the Council makes; the model gateway implements it. */
export interface CouncilModel {
  councilComplete(guildId: string, call: CouncilCall): Promise<CouncilReply>
}

/** Parses a voice's raw reply into a vote, or null when it is not a valid vote. */
export function parseVoteOutput(_text: string): VoteOutput | null {
  throw new Error('not implemented')
}

/** The tally's decision and why. */
export interface TallyResult {
  decision: 'escalate'
  reason: string
}

/** Tallies the votes. */
export function tally(_votes: readonly CouncilVote[]): TallyResult {
  throw new Error('not implemented')
}

/** The fixed system text of a voice. */
export function voiceSystem(_voice: CouncilVoice): string {
  throw new Error('not implemented')
}

/** The brief one voice receives. */
export function buildBrief(_voice: CouncilVoice, _content: string, _nonce: string): string {
  throw new Error('not implemented')
}

/** Seal evidence for a session's votes. */
export function councilEvidence(_votes: readonly CouncilVote[], _reason: string): string {
  throw new Error('not implemented')
}

/** What {@link CouncilEngine.convene} did. */
export type ConveneResult =
  | { status: 'cap_reached' }
  | { status: 'escalated'; session: CouncilSession; votes: CouncilVote[]; reason: string }

/** The Council of Elders. */
export class CouncilEngine {
  constructor(readonly deps: { store: CouncilStore; model: CouncilModel; clock: Clock }) {}

  async convene(
    _guildId: string,
    _input: {
      quest: { id: string; hallId: string }
      proposal: { hash: string; content: string }
      sessionCap: number
    }
  ): Promise<ConveneResult> {
    throw new Error('not implemented')
  }
}
