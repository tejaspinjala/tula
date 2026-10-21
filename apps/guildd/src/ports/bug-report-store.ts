import { z } from 'zod'
import { hashBytes } from './object-store'
import type { NewQuest, Quest } from './quest-queue'

/** Largest page a {@link BugReportStore} list returns. */
export const MAX_BUG_REPORT_PAGE = 100

/** Most evidence references a Bug Report carries. */
export const MAX_BUG_REPORT_EVIDENCE = 20

const field = z.string().max(600)

/**
 * The reproduction as a boundary parses it: every field optional so that a missing or blank one is
 * refused by code as `reproduction_required`, not as a malformed request.
 */
export const reproductionInput = z.strictObject({
  steps: field.optional(),
  expected: field.optional(),
  actual: field.optional(),
})

/** A complete reproduction: how to trigger the defect, what should happen, what does. */
export const reproduction = z.strictObject({
  steps: z.string().trim().min(1).max(600),
  expected: z.string().trim().min(1).max(600),
  actual: z.string().trim().min(1).max(600),
})
/** A complete reproduction. */
export type Reproduction = z.infer<typeof reproduction>

/** One piece of evidence: an artifact hash (64 lowercase hex characters) or a Dossier id. */
export const bugEvidenceRef = z.union([z.string().regex(/^[0-9a-f]{64}$/), z.uuid()])

/** The fields a Bug Report is filed with at a boundary (route or tool). */
export const fileBugReportInput = z.strictObject({
  owningHall: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  reproduction: reproductionInput.optional(),
  evidence: z.array(bugEvidenceRef).max(MAX_BUG_REPORT_EVIDENCE).default([]),
})

/** SHA-256 over the owning Hall and the reproduction; two reports with the same one describe the same defect. */
export function reproductionHash(owningHall: string, r: Reproduction): string {
  return hashBytes(
    new TextEncoder().encode(JSON.stringify([owningHall, r.steps, r.expected, r.actual]))
  )
}

/** Where a Bug Report stands: `open` (its Fix Quest is on the board), `duplicate` of an open one, or `fixed`. */
export const BUG_REPORT_STATUSES = ['open', 'duplicate', 'fixed'] as const
/** Where a Bug Report stands. */
export type BugReportStatus = (typeof BUG_REPORT_STATUSES)[number]

/** Who filed a Bug Report: a Member's Quest (charged the cap) or the Guild Master. */
export type BugReportFiler =
  | { kind: 'member'; questId: string; hallId: string; memberId: string }
  | { kind: 'guild_master' }

/** A stored Bug Report. */
export interface BugReport {
  id: string
  /** Ordering key: later reports have a larger one; the page cursor. */
  seq: number
  owningHall: string
  title: string
  reproduction: Reproduction
  reproductionHash: string
  evidence: string[]
  filer: BugReportFiler
  status: BugReportStatus
  /** The open report this one duplicates; null unless `duplicate`. */
  duplicateOf: string | null
  /** The Fix Quest posted for it; null for a duplicate. */
  fixQuestId: string | null
  /** The Handoff hash of the accepted fix; null until `fixed`. */
  fixHandoffHash: string | null
  createdAt: string
  fixedAt: string | null
}

/** What filing a Bug Report stores. The store decides duplicate or not and posts `fixQuest` only for a new defect. */
export interface NewBugReport {
  owningHall: string
  title: string
  reproduction: Reproduction
  evidence: string[]
  filer: BugReportFiler
  /** The Fix Quest to post on the owning Hall's Quest Board, in the same transaction, unless this is a duplicate. */
  fixQuest: NewQuest
  /** The most Bug Reports the filing Quest may file (all attempts); charged to a Member filer only. */
  maxPerQuest?: number
  at: Date
}

/** The outcome of filing: the stored report (and the Fix Quest unless duplicate), or `bug_report_cap`. */
export type FileBugReportResult =
  | { ok: true; report: BugReport; fixQuest: Quest | null }
  | { ok: false; error: 'bug_report_cap' }

/** What a list selects: one Hall's Bug Reports, optionally by status. */
export interface BugReportQuery {
  hallId: string
  status?: BugReportStatus
  /** The cursor from the previous page. */
  after?: number
  limit: number
}

/** One page of Bug Reports, newest first; `next` is the cursor for the following page, null at the end. */
export interface BugReportPage {
  reports: BugReport[]
  next: number | null
}

/**
 * Port for Bug Reports. Filing is one atomic step: cap check, duplicate check, the Fix Quest post,
 * the insert and the audit event all commit together. A report only ever moves `open` to `fixed`,
 * and that move happens inside the HandoffStore write of its Fix Quest's accepted Handoff.
 */
export interface BugReportStore {
  /** Files a report; see {@link NewBugReport}. */
  file(guildId: string, input: NewBugReport): Promise<FileBugReportResult>
  /** How many reports the Quest has filed (all attempts): a cheap pre-check; `file` stays the authority. */
  countForQuest(guildId: string, questId: string): Promise<number>
  /** One report, or null when absent for this guild. */
  get(guildId: string, id: string): Promise<BugReport | null>
  /** The report whose Fix Quest is `questId`, or null. */
  forFixQuest(guildId: string, questId: string): Promise<BugReport | null>
  /** One page of a Hall's reports, newest first. */
  list(guildId: string, query: BugReportQuery): Promise<BugReportPage>
}
