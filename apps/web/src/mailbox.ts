import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** One Inquiry as the mailbox shows it (question and answer are Member text: render as text only). */
export interface MailInquiry {
  id: string
  seq: number
  fromHall: string
  toHall: string
  asker: string
  question: string
  status: 'open' | 'answered' | 'expired'
  answer: string | null
  answerQuestId: string
  askedAt: string
}

/** One Dossier: the checks its Quest's records passed or failed. */
export interface MailDossier {
  id: string
  seq: number
  subjectQuestId: string
  subjectHallId: string
  body: { goal: string; doneCondition: string; met: boolean }
  verified: boolean
  failedChecks: string[]
  createdAt: string
}

/** One Bug Report with its reproduction, status and Fix Quest id. */
export interface MailBugReport {
  id: string
  seq: number
  owningHall: string
  title: string
  reproduction: { steps: string; expected: string; actual: string }
  status: 'open' | 'duplicate' | 'fixed'
  duplicateOf: string | null
  fixQuestId: string | null
  createdAt: string
}

/** The paging and filter options of a mailbox list. */
export interface MailboxQuery {
  limit: number
  after?: number
  status?: MailBugReport['status']
}

/** Reads one page of a Hall's Inquiries. */
export async function loadInquiries(
  _session: Session,
  _fetcher: Fetcher,
  _hallId: string,
  _query: MailboxQuery
): Promise<{ inquiries: MailInquiry[]; next: number | null }> {
  throw new Error('not built')
}

/** Reads one page of a Hall's Dossiers. */
export async function loadDossiers(
  _session: Session,
  _fetcher: Fetcher,
  _hallId: string,
  _query: MailboxQuery
): Promise<{ dossiers: MailDossier[]; next: number | null }> {
  throw new Error('not built')
}

/** Reads one page of a Hall's Bug Reports. */
export async function loadBugReports(
  _session: Session,
  _fetcher: Fetcher,
  _hallId: string,
  _query: MailboxQuery
): Promise<{ reports: MailBugReport[]; next: number | null }> {
  throw new Error('not built')
}

/** Requests a Dossier for a finished Quest. */
export async function requestDossier(
  _session: Session,
  _fetcher: Fetcher,
  _questId: string
): Promise<MailDossier> {
  throw new Error('not built')
}

/** Files a Bug Report against a Hall. */
export async function fileBugReport(
  _session: Session,
  _fetcher: Fetcher,
  _input: {
    owningHall: string
    title: string
    reproduction: { steps: string; expected: string; actual: string }
  }
): Promise<{ report: MailBugReport; fixQuestId: string | null }> {
  throw new Error('not built')
}

/** The in-world line for a refused mailbox request. */
export function mailboxRefusal(_error: unknown): string {
  throw new Error('not built')
}
