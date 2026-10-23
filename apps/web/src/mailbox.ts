import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

// The Guild Master's mailbox routes (Inquiries, Dossiers, Bug Reports) are read and written only
// here, validated with Zod, so a later shape change on the server is a change to this one file.

const inquiryBody = z.object({
  id: z.string(),
  seq: z.number(),
  fromHall: z.string(),
  toHall: z.string(),
  asker: z.string(),
  question: z.string(),
  status: z.enum(['open', 'answered', 'expired']),
  answer: z.string().nullable(),
  answerQuestId: z.string(),
  askedAt: z.string(),
})
const dossierBody = z.object({
  id: z.string(),
  seq: z.number(),
  subjectQuestId: z.string(),
  subjectHallId: z.string(),
  body: z.object({ goal: z.string(), doneCondition: z.string(), met: z.boolean() }),
  verified: z.boolean(),
  failedChecks: z.array(z.string()),
  createdAt: z.string(),
})
const reportBody = z.object({
  id: z.string(),
  seq: z.number(),
  owningHall: z.string(),
  title: z.string(),
  reproduction: z.object({ steps: z.string(), expected: z.string(), actual: z.string() }),
  status: z.enum(['open', 'duplicate', 'fixed']),
  duplicateOf: z.string().nullable(),
  fixQuestId: z.string().nullable(),
  createdAt: z.string(),
})
const next = z.number().nullable()

/** One Inquiry as the mailbox shows it (question and answer are Member text: render as text only). */
export type MailInquiry = z.infer<typeof inquiryBody>

/** One Dossier: the checks its Quest's records passed or failed. */
export type MailDossier = z.infer<typeof dossierBody>

/** One Bug Report with its reproduction, status and Fix Quest id. */
export type MailBugReport = z.infer<typeof reportBody>

/** The paging and filter options of a mailbox list. */
export interface MailboxQuery {
  limit: number
  after?: number
  status?: MailBugReport['status']
}

async function call<T>(
  session: Session,
  fetcher: Fetcher,
  path: string,
  schema: z.ZodType<T>,
  init?: { method: 'POST'; body: unknown }
): Promise<T> {
  const res = await fetcher(`/api/guilds/${session.guildId}${path}`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(init ? { 'content-type': 'application/json' } : {}),
    },
    ...(init ? { method: init.method, body: JSON.stringify(init.body) } : {}),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return schema.parse(data)
}

function listPath(hallId: string, kind: string, query: MailboxQuery): string {
  const after = query.after === undefined ? '' : `&after=${query.after}`
  const status = query.status === undefined ? '' : `&status=${query.status}`
  return `/halls/${encodeURIComponent(hallId)}/${kind}?limit=${query.limit}${after}${status}`
}

/** Reads one page of a Hall's Inquiries (asked or answered), newest first. */
export function loadInquiries(
  session: Session,
  fetcher: Fetcher,
  hallId: string,
  query: MailboxQuery
): Promise<{ inquiries: MailInquiry[]; next: number | null }> {
  return call(
    session,
    fetcher,
    listPath(hallId, 'inquiries', query),
    z.object({ inquiries: z.array(inquiryBody), next })
  )
}

/** Reads one page of a Hall's Dossiers, newest first. */
export function loadDossiers(
  session: Session,
  fetcher: Fetcher,
  hallId: string,
  query: MailboxQuery
): Promise<{ dossiers: MailDossier[]; next: number | null }> {
  return call(
    session,
    fetcher,
    listPath(hallId, 'dossiers', query),
    z.object({ dossiers: z.array(dossierBody), next })
  )
}

/** Reads one page of a Hall's Bug Reports, newest first, optionally by status. */
export function loadBugReports(
  session: Session,
  fetcher: Fetcher,
  hallId: string,
  query: MailboxQuery
): Promise<{ reports: MailBugReport[]; next: number | null }> {
  return call(
    session,
    fetcher,
    listPath(hallId, 'bug-reports', query),
    z.object({ reports: z.array(reportBody), next })
  )
}

/** Requests a Dossier for a finished Quest. */
export function requestDossier(
  session: Session,
  fetcher: Fetcher,
  questId: string
): Promise<MailDossier> {
  return call(session, fetcher, '/dossiers', dossierBody, { method: 'POST', body: { questId } })
}

/** What the Guild Master fills in to file a Bug Report. */
export interface NewMailBugReport {
  owningHall: string
  title: string
  reproduction: { steps: string; expected: string; actual: string }
}

/** Files a Bug Report against a Hall; returns it with the Fix Quest posted for it (null for a duplicate). */
export async function fileBugReport(
  session: Session,
  fetcher: Fetcher,
  input: NewMailBugReport
): Promise<{ report: MailBugReport; fixQuestId: string | null }> {
  const filed = await call(
    session,
    fetcher,
    '/bug-reports',
    reportBody.extend({ fixQuest: z.object({ id: z.string() }).nullable().optional() }),
    { method: 'POST', body: input }
  )
  const { fixQuest, ...report } = filed
  return { report, fixQuestId: fixQuest?.id ?? report.fixQuestId }
}

const REFUSALS: Record<string, string> = {
  quest_not_found: 'No Quest by that id is in this guild.',
  quest_not_finished: 'That Quest has not finished yet, so there is nothing to put in a Dossier.',
  dossier_cap: 'This Quest has already asked for as many Dossiers as it may.',
  hall_not_found: 'No Hall by that name is in this guild.',
  reproduction_required:
    'A Bug Report needs all three lines: the steps, what should happen and what does.',
  hall_locked: 'That Hall is locked, so it cannot take a Fix Quest.',
  hall_has_no_owner: 'That Hall has no one to take a Fix Quest.',
  bug_report_cap: 'This Quest has already filed as many Bug Reports as it may.',
  invalid_request: 'The form is missing something. Check each line and try again.',
}

/** The in-world line for a refused mailbox request (never a raw server code). */
export function mailboxRefusal(error: unknown): string {
  if (error instanceof PasskeyRequestError) {
    return REFUSALS[error.code] ?? 'The courier came back without an answer. Try again.'
  }
  return 'The courier could not get through. Try again.'
}

/** How many Inquiries still wait for an answer in the given Halls (the first page of each): the Mailbox's unread count. */
export async function countOpenInquiries(
  session: Session,
  fetcher: Fetcher,
  hallIds: readonly string[]
): Promise<number> {
  const pages = await Promise.all(
    hallIds.map((id) => loadInquiries(session, fetcher, id, { limit: 50 }))
  )
  return pages.reduce((sum, p) => sum + p.inquiries.filter((i) => i.status === 'open').length, 0)
}
