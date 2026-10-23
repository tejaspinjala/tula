import { expect, test } from 'bun:test'
import {
  countUnread,
  fileBugReport,
  loadBugReports,
  loadDossiers,
  loadInquiries,
  mailboxRefusal,
  markMailboxRead,
  requestDossier,
} from './mailbox'
import { PasskeyRequestError } from './passkeys'

const session = { token: 't1', guildId: 'g1' }
const hash = 'a'.repeat(64)
const dossier = {
  id: 'd1',
  seq: 4,
  subjectQuestId: 'q1',
  subjectHallId: 'heralds',
  requester: { kind: 'guild_master' },
  body: {
    questId: 'q1',
    hallId: 'heralds',
    goal: 'Write the notice',
    doneCondition: 'Notice filed',
    met: true,
    verdict: null,
    seal: null,
    handoffHash: hash,
    artifacts: [{ hash, size: 12 }],
  },
  hash,
  verified: false,
  failedChecks: ['artifact_missing'],
  createdAt: '2026-10-20T10:00:00.000Z',
}
const report = {
  id: 'b1',
  seq: 2,
  owningHall: 'heralds',
  title: 'Ledger totals drift',
  reproduction: { steps: 'Open it', expected: 'Sum', actual: 'Off by one' },
  reproductionHash: hash,
  evidence: [],
  filer: { kind: 'guild_master' },
  status: 'open',
  duplicateOf: null,
  fixQuestId: 'fq1',
  fixHandoffHash: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  fixedAt: null,
}

function stub(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetcher = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      const next = responses.shift()
      return Response.json(next?.body ?? {}, { status: next?.status ?? 200 })
    },
    { preconnect: fetch.preconnect }
  )
  return { calls, fetcher }
}

test('loadDossiers reads one Hall page with the session token and parses the checks', async () => {
  const { calls, fetcher } = stub([{ status: 200, body: { dossiers: [dossier], next: 4 } }])
  const page = await loadDossiers(session, fetcher, 'heralds', { limit: 20, after: 9 })
  expect(calls[0]?.url).toBe('/api/guilds/g1/halls/heralds/dossiers?limit=20&after=9')
  expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer t1')
  expect(page.next).toBe(4)
  expect(page.dossiers[0]?.failedChecks).toEqual(['artifact_missing'])
})

test('loadInquiries and loadBugReports read their pages; bug reports filter by status', async () => {
  const inquiry = {
    seq: 1,
    id: 'i1',
    fromHall: 'heralds',
    toHall: 'vaults',
    askQuestId: 'q1',
    answerQuestId: 'q2',
    asker: 'm1',
    question: 'Where is the key?',
    status: 'answered',
    answer: 'Under the mat.',
    answeredBy: 'm9',
    noteId: null,
    askedAt: '2026-10-20T10:00:00.000Z',
    expiresAt: '2026-10-21T10:00:00.000Z',
    answeredAt: '2026-10-20T11:00:00.000Z',
  }
  const { calls, fetcher } = stub([
    { status: 200, body: { inquiries: [inquiry], next: null } },
    { status: 200, body: { reports: [report], next: null } },
  ])
  const inquiries = await loadInquiries(session, fetcher, 'heralds', { limit: 20 })
  expect(inquiries.inquiries[0]?.answer).toBe('Under the mat.')
  const reports = await loadBugReports(session, fetcher, 'heralds', { limit: 20, status: 'open' })
  expect(calls[1]?.url).toBe('/api/guilds/g1/halls/heralds/bug-reports?limit=20&status=open')
  expect(reports.reports[0]?.reproduction.actual).toBe('Off by one')
})

test('a refused read throws the server code; a changed shape is refused, not trusted', async () => {
  const gone = stub([{ status: 404, body: { error: 'hall_not_found' } }])
  await expect(loadDossiers(session, gone.fetcher, 'x', { limit: 20 })).rejects.toEqual(
    new PasskeyRequestError(404, 'hall_not_found')
  )
  const odd = stub([{ status: 200, body: { dossiers: [{ id: 1 }], next: null } }])
  await expect(loadDossiers(session, odd.fetcher, 'x', { limit: 20 })).rejects.toThrow()
})

test('requestDossier posts the Quest id; fileBugReport posts the report and returns the Fix Quest id', async () => {
  const made = stub([
    { status: 201, body: dossier },
    { status: 201, body: { ...report, fixQuest: { id: 'fq1' } } },
  ])
  const d = await requestDossier(session, made.fetcher, 'q1')
  expect(made.calls[0]?.url).toBe('/api/guilds/g1/dossiers')
  expect(made.calls[0]?.init?.body).toBe(JSON.stringify({ questId: 'q1' }))
  expect(d.id).toBe('d1')
  const filed = await fileBugReport(session, made.fetcher, {
    owningHall: 'heralds',
    title: 'Ledger totals drift',
    reproduction: { steps: 'Open it', expected: 'Sum', actual: 'Off by one' },
  })
  expect(made.calls[1]?.url).toBe('/api/guilds/g1/bug-reports')
  expect(filed.report.id).toBe('b1')
  expect(filed.fixQuestId).toBe('fq1')
})

test('every refusal the server can give reads as an in-world line', () => {
  for (const code of [
    'quest_not_found',
    'quest_not_finished',
    'dossier_cap',
    'hall_not_found',
    'reproduction_required',
    'hall_locked',
    'hall_has_no_owner',
    'bug_report_cap',
    'invalid_request',
  ]) {
    expect(mailboxRefusal(new PasskeyRequestError(422, code))).not.toContain('_')
  }
  expect(mailboxRefusal(new PasskeyRequestError(422, 'quest_not_finished'))).toBe(
    'That Quest has not finished yet, so there is nothing to put in a Dossier.'
  )
  expect(mailboxRefusal(new Error('boom'))).toBe('The courier could not get through. Try again.')
})

test('countUnread reads the server total, which counts an Inquiry between two Halls once', async () => {
  const { calls, fetcher } = stub([
    { status: 200, body: { halls: { heralds: 2, health: 2 }, total: 2 } },
  ])
  expect(await countUnread(session, fetcher)).toBe(2)
  expect(calls[0]?.url).toBe('/api/guilds/g1/mailbox/unread')
})

test('markMailboxRead posts the newest seen seq for one Hall and returns the marker', async () => {
  const { calls, fetcher } = stub([{ status: 200, body: { seen: 7, unread: 0 } }])
  expect(await markMailboxRead(session, fetcher, 'heralds', 7)).toEqual({ seen: 7, unread: 0 })
  expect(calls[0]?.url).toBe('/api/guilds/g1/halls/heralds/mailbox/read')
  expect(calls[0]?.init?.method).toBe('POST')
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ upToSeq: 7 })
})
