import type {
  CouncilSession,
  CouncilStore,
  CouncilVote,
  NewCouncilVote,
  OpenSessionResult,
} from '../ports/council-store'

/** Memory {@link CouncilStore}: state in this instance only; each write is one synchronous step. */
export class MemoryCouncilStore implements CouncilStore {
  throw(): never {
    throw new Error('not implemented')
  }

  async open(
    _g: string,
    _i: { questId: string; proposalHash: string; day: string; sessionCap: number }
  ): Promise<OpenSessionResult> {
    return this.throw()
  }

  async recordVote(_guildId: string, _sessionId: string, _vote: NewCouncilVote): Promise<boolean> {
    return this.throw()
  }

  async votes(_g: string, _s: string): Promise<CouncilVote[]> {
    return this.throw()
  }

  async escalate(_g: string, _s: string, _r: string): Promise<boolean> {
    return this.throw()
  }
}

export type { CouncilSession }
