import {
  type BugReport,
  type BugReportPage,
  type BugReportQuery,
  type BugReportStore,
  type FileBugReportResult,
  type NewBugReport,
  reproductionHash,
} from '../ports/bug-report-store'
import type { MemoryQuestQueue } from './memory-quest-queue'

/**
 * Memory adapter for {@link BugReportStore}. `file` runs the cap check, the duplicate check, the
 * Fix Quest post and the insert with no `await` between, so same-tick filings cannot overshoot the
 * cap or both claim the open slot. A Quest refiling the same reproduction (its job key) gets its
 * first report back whatever the title or evidence, uncharged. State lives in this instance only.
 */
export class MemoryBugReportStore implements BugReportStore {
  private readonly guilds = new Map<string, BugReport[]>()
  private nextSeq = 1

  /** `onEvent` receives each appended event's type and ids-and-hashes-only payload. */
  constructor(
    private readonly quests: MemoryQuestQueue,
    private readonly onEvent: (guildId: string, type: string, payload: object) => void = () => {}
  ) {}

  private reports(guildId: string): BugReport[] {
    let all = this.guilds.get(guildId)
    if (!all) {
      all = []
      this.guilds.set(guildId, all)
    }
    return all
  }

  async file(guildId: string, input: NewBugReport): Promise<FileBugReportResult> {
    const all = this.reports(guildId)
    const { filer } = input
    const hash = reproductionHash(input.owningHall, input.reproduction)
    const prior =
      filer.kind === 'member'
        ? all.find(
            (r) =>
              r.filer.kind === 'member' &&
              r.filer.questId === filer.questId &&
              r.reproductionHash === hash
          )
        : undefined
    if (prior) {
      return { ok: true, report: { ...prior }, fixQuest: null }
    }
    if (
      filer.kind === 'member' &&
      input.maxPerQuest !== undefined &&
      all.filter((r) => r.filer.kind === 'member' && r.filer.questId === filer.questId).length >=
        input.maxPerQuest
    ) {
      return { ok: false, error: 'bug_report_cap' }
    }
    const open = all.find(
      (r) => r.status === 'open' && r.owningHall === input.owningHall && r.reproductionHash === hash
    )
    const posted = open ? null : this.quests.postNow(guildId, input.fixQuest).quest
    const report: BugReport = {
      id: crypto.randomUUID(),
      seq: this.nextSeq++,
      owningHall: input.owningHall,
      title: input.title,
      reproduction: input.reproduction,
      reproductionHash: hash,
      evidence: [...input.evidence],
      filer,
      status: open ? 'duplicate' : 'open',
      duplicateOf: open?.id ?? null,
      fixQuestId: posted?.id ?? null,
      fixHandoffHash: null,
      createdAt: input.at.toISOString(),
      fixedAt: null,
    }
    all.push(report)
    this.onEvent(
      guildId,
      open ? 'bug_report.duplicate' : 'bug_report.filed',
      open
        ? { bugReportId: report.id, duplicateOf: open.id, owningHall: report.owningHall }
        : {
            bugReportId: report.id,
            fixQuestId: posted?.id ?? null,
            owningHall: report.owningHall,
            reproductionHash: hash,
          }
    )
    return { ok: true, report, fixQuest: posted }
  }

  /**
   * Marks the report whose Fix Quest is `questId` fixed by `handoffHash`; a no-op unless it is open,
   * so a retry changes nothing. Runs in one synchronous step, as atomic as the Postgres adapter.
   */
  async closeFixed(guildId: string, questId: string, handoffHash: string, at: Date): Promise<void> {
    const report = this.reports(guildId).find((r) => r.fixQuestId === questId)
    if (report?.status !== 'open') {
      return
    }
    report.status = 'fixed'
    report.fixHandoffHash = handoffHash
    report.fixedAt = at.toISOString()
    this.onEvent(guildId, 'bug_report.fixed', {
      bugReportId: report.id,
      fixQuestId: questId,
      owningHall: report.owningHall,
      handoffHash,
    })
  }

  async countForQuest(guildId: string, questId: string): Promise<number> {
    return this.reports(guildId).filter(
      (r) => r.filer.kind === 'member' && r.filer.questId === questId
    ).length
  }

  async get(guildId: string, id: string): Promise<BugReport | null> {
    const found = this.reports(guildId).find((r) => r.id === id)
    return found ? { ...found } : null
  }

  async forFixQuest(guildId: string, questId: string): Promise<BugReport | null> {
    const found = this.reports(guildId).find((r) => r.fixQuestId === questId)
    return found ? { ...found } : null
  }

  async list(guildId: string, query: BugReportQuery): Promise<BugReportPage> {
    const visible = this.reports(guildId)
      .filter(
        (r) =>
          r.owningHall === query.hallId &&
          (query.status === undefined || r.status === query.status) &&
          (query.after === undefined || r.seq < query.after)
      )
      .sort((a, b) => b.seq - a.seq)
    const page = visible.slice(0, query.limit).map((r) => ({ ...r }))
    const last = page.at(-1)
    return { reports: page, next: visible.length > page.length && last ? last.seq : null }
  }
}
