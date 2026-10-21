import {
  COUNCIL_VOICES,
  type CouncilSession,
  type CouncilStore,
  type CouncilVote,
  type NewCouncilVote,
  type OpenSessionResult,
} from '../ports/council-store'

/** Memory {@link CouncilStore}: state in this instance only; each write is one synchronous step. */
export class MemoryCouncilStore implements CouncilStore {
  /** Sessions by `guild:proposalHash`, the unique key. */
  private readonly sessions = new Map<string, CouncilSession>()
  /** Session ids to their guild, so another guild's id resolves to nothing. */
  private readonly owners = new Map<string, string>()
  private readonly voteRows = new Map<string, CouncilVote>()

  async open(
    guildId: string,
    input: { questId: string; proposalHash: string; day: string; sessionCap: number }
  ): Promise<OpenSessionResult> {
    const key = `${guildId}:${input.proposalHash}`
    const existing = this.sessions.get(key)
    if (existing) {
      return { status: 'existing', session: { ...existing } }
    }
    let today = 0
    for (const [k, s] of this.sessions) {
      if (k.startsWith(`${guildId}:`) && s.day === input.day) {
        today += 1
      }
    }
    if (today >= input.sessionCap) {
      return { status: 'cap_reached' }
    }
    const session: CouncilSession = {
      id: crypto.randomUUID(),
      questId: input.questId,
      proposalHash: input.proposalHash,
      day: input.day,
      status: 'open',
      reason: null,
      createdAt: new Date().toISOString(),
    }
    this.sessions.set(key, session)
    this.owners.set(session.id, guildId)
    return { status: 'created', session: { ...session } }
  }

  async recordVote(guildId: string, sessionId: string, vote: NewCouncilVote): Promise<boolean> {
    if (this.owners.get(sessionId) !== guildId) {
      return false
    }
    const key = `${sessionId}:${vote.voice}`
    if (this.voteRows.has(key)) {
      return false
    }
    this.voteRows.set(key, { ...vote, reasons: [...vote.reasons], sessionId })
    return true
  }

  async votes(guildId: string, sessionId: string): Promise<CouncilVote[]> {
    if (this.owners.get(sessionId) !== guildId) {
      return []
    }
    return COUNCIL_VOICES.flatMap((voice) => {
      const v = this.voteRows.get(`${sessionId}:${voice}`)
      return v ? [{ ...v, reasons: [...v.reasons] }] : []
    })
  }

  async escalate(guildId: string, sessionId: string, reason: string): Promise<boolean> {
    if (this.owners.get(sessionId) !== guildId) {
      return false
    }
    for (const s of this.sessions.values()) {
      if (s.id === sessionId) {
        if (s.status === 'escalated') {
          return false
        }
        s.status = 'escalated'
        s.reason = reason
        return true
      }
    }
    return false
  }
}
