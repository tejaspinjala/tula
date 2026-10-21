import {
  type ApproveResult,
  COUNCIL_VOICES,
  type CouncilSession,
  type CouncilStore,
  type CouncilVote,
  MAX_APPROVAL_LOOKUP,
  type NewCouncilVote,
  type OpenSessionResult,
} from '../ports/council-store'

/** Memory {@link CouncilStore}: state in this instance only; each write is one synchronous step. */
export class MemoryCouncilStore implements CouncilStore {
  /** Sessions by `guild:proposalHash`, the unique key. */
  private readonly sessions = new Map<string, CouncilSession>()
  /** Session ids to their guild, so another guild's id resolves to nothing. */
  private readonly owners = new Map<string, string>()
  /** Live claims: session id to the owner and the epoch ms the claim ends. */
  private readonly claims = new Map<string, { owner: string; until: number }>()
  private readonly failures = new Map<string, number>()
  /** One row per (session, Quest) approval. */
  private readonly approvals: Array<{
    guildId: string
    sessionId: string
    questId: string
    day: string
  }> = []
  private readonly halts = new Set<string>()
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

  async list(
    guildId: string,
    page: { limit: number; after?: string }
  ): Promise<{ sessions: CouncilSession[]; next: string | null }> {
    // Map iteration is insertion order, so reversing it is newest first even within one tick.
    const mine = [...this.sessions.entries()]
      .filter(([key]) => key.startsWith(`${guildId}:`))
      .map(([, session]) => session)
      .reverse()
    let from = 0
    if (page.after !== undefined) {
      const at = mine.findIndex((s) => s.id === page.after)
      if (at === -1) {
        return { sessions: [], next: null }
      }
      from = at + 1
    }
    const rows = mine.slice(from, from + page.limit)
    const last = rows[rows.length - 1]
    const more = from + page.limit < mine.length
    return { sessions: rows.map((s) => ({ ...s })), next: more && last ? last.id : null }
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

  async claim(
    guildId: string,
    sessionId: string,
    owner: string,
    now: Date,
    ttlMs: number
  ): Promise<boolean> {
    const session = this.find(guildId, sessionId)
    if (!session || session.status !== 'open') {
      return false
    }
    const held = this.claims.get(sessionId)
    if (held && held.owner !== owner && held.until > now.getTime()) {
      return false
    }
    this.claims.set(sessionId, { owner, until: now.getTime() + ttlMs })
    return true
  }

  async release(guildId: string, sessionId: string, owner: string): Promise<void> {
    if (this.find(guildId, sessionId) && this.claims.get(sessionId)?.owner === owner) {
      this.claims.delete(sessionId)
    }
  }

  async recordFailure(guildId: string, sessionId: string): Promise<number> {
    if (!this.find(guildId, sessionId)) {
      return 0
    }
    const n = (this.failures.get(sessionId) ?? 0) + 1
    this.failures.set(sessionId, n)
    return n
  }

  private find(guildId: string, sessionId: string): CouncilSession | undefined {
    if (this.owners.get(sessionId) !== guildId) {
      return undefined
    }
    for (const s of this.sessions.values()) {
      if (s.id === sessionId) {
        return s
      }
    }
    return undefined
  }

  async escalate(guildId: string, sessionId: string, reason: string): Promise<boolean> {
    if (this.owners.get(sessionId) !== guildId) {
      return false
    }
    for (const s of this.sessions.values()) {
      if (s.id === sessionId) {
        if (s.status !== 'open') {
          return false
        }
        s.status = 'escalated'
        s.reason = reason
        this.claims.delete(sessionId)
        return true
      }
    }
    return false
  }

  async approvalsToday(guildId: string, day: string, excludingQuestId: string): Promise<number> {
    return this.approvals.filter(
      (a) => a.guildId === guildId && a.day === day && a.questId !== excludingQuestId
    ).length
  }

  async approve(
    guildId: string,
    sessionId: string,
    input: { questId: string; day: string; cap: number }
  ): Promise<ApproveResult> {
    const session = this.find(guildId, sessionId)
    if (!session || session.status === 'escalated') {
      return 'not_found'
    }
    if (this.approvals.some((a) => a.sessionId === sessionId && a.questId === input.questId)) {
      return 'approved'
    }
    const taken = this.approvals.filter((a) => a.guildId === guildId && a.day === input.day).length
    if (taken >= input.cap) {
      return 'cap_reached'
    }
    this.approvals.push({ guildId, sessionId, questId: input.questId, day: input.day })
    session.status = 'approved'
    this.claims.delete(sessionId)
    return 'approved'
  }

  async halt(guildId: string, sessionId: string, questId: string): Promise<boolean> {
    if (!this.find(guildId, sessionId)) {
      return false
    }
    const key = `${sessionId}:${questId}`
    if (this.halts.has(key)) {
      return false
    }
    // The memory adapter keeps no event log; the Postgres adapter appends `council.halted`.
    this.halts.add(key)
    return true
  }

  async haltedSessions(
    _guildId: string,
    _sessionIds: readonly string[]
  ): Promise<ReadonlySet<string>> {
    return new Set()
  }

  async approvalFor(
    guildId: string,
    questId: string,
    proposalHash: string
  ): Promise<string | null> {
    return this.approvalSync(guildId, questId, proposalHash)
  }

  private approvalSync(guildId: string, questId: string, proposalHash: string): string | null {
    const session = this.sessions.get(`${guildId}:${proposalHash}`)
    const given = this.approvals.some((a) => a.sessionId === session?.id && a.questId === questId)
    return session && given ? session.id : null
  }

  async approvalsFor(
    guildId: string,
    proposals: ReadonlyArray<{ questId: string; proposalHash: string }>
  ): Promise<Array<{ questId: string; proposalHash: string; sessionId: string }>> {
    const found: Array<{ questId: string; proposalHash: string; sessionId: string }> = []
    for (const { questId, proposalHash } of proposals.slice(0, MAX_APPROVAL_LOOKUP)) {
      const sessionId = this.approvalSync(guildId, questId, proposalHash)
      if (sessionId !== null) {
        found.push({ questId, proposalHash, sessionId })
      }
    }
    return found
  }
}
