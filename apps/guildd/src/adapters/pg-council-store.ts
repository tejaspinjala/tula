import type { Db } from '../db/client'
import type {
  CouncilStore,
  CouncilVote,
  NewCouncilVote,
  OpenSessionResult,
} from '../ports/council-store'
import type { KeyProvider } from '../ports/key-provider'

/** Postgres {@link CouncilStore}. */
export class PgCouncilStore implements CouncilStore {
  constructor(
    readonly db: Db,
    readonly keys: KeyProvider
  ) {}

  async open(
    _g: string,
    _i: { questId: string; proposalHash: string; day: string; sessionCap: number }
  ): Promise<OpenSessionResult> {
    throw new Error('not implemented')
  }

  async recordVote(_guildId: string, _sessionId: string, _vote: NewCouncilVote): Promise<boolean> {
    throw new Error('not implemented')
  }

  async votes(_g: string, _s: string): Promise<CouncilVote[]> {
    throw new Error('not implemented')
  }

  async escalate(_g: string, _s: string, _r: string): Promise<boolean> {
    throw new Error('not implemented')
  }
}
