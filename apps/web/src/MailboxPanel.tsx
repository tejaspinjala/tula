import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Badge, type Tone } from './Badge'
import { mailboxCount, useLiveEvents } from './live-events'
import {
  fileBugReport,
  loadBugReports,
  loadDossiers,
  loadInquiries,
  type MailBugReport,
  type MailDossier,
  type MailInquiry,
  mailboxRefusal,
  requestDossier,
} from './mailbox'
import type { Session } from './passkeys'
import { loadRoster, type Roster } from './roster'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/** Rows per page. */
const PAGE = 20

const TABS = [
  { id: 'inquiries', label: 'Inquiries' },
  { id: 'dossiers', label: 'Dossiers' },
  { id: 'bugs', label: 'Bug Reports' },
] as const
type TabId = (typeof TABS)[number]['id']
type BugStatus = MailBugReport['status']

/** One mailbox row, whatever the tab: a title, a status chip and the detail that opens under it. */
interface Row {
  id: string
  title: string
  chip: { tone: Tone; text: string }
  detail: ReactNode
}

const INQUIRY_TONE: Record<MailInquiry['status'], Tone> = {
  open: 'warn',
  answered: 'ok',
  expired: 'danger',
}
const BUG_TONE: Record<BugStatus, Tone> = { open: 'warn', duplicate: 'neutral', fixed: 'ok' }

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p>
      <strong>{label}</strong> {children}
    </p>
  )
}

function inquiryRow(i: MailInquiry, hallName: (id: string) => string): Row {
  return {
    id: i.id,
    title: `${hallName(i.fromHall)} asks ${hallName(i.toHall)}: ${i.question.slice(0, 60)}`,
    chip: { tone: INQUIRY_TONE[i.status], text: i.status },
    detail: (
      <>
        <Fact label="Question">{i.question}</Fact>
        <Fact label="Answer">{i.answer ?? 'Not answered yet.'}</Fact>
      </>
    ),
  }
}

function dossierRow(d: MailDossier): Row {
  return {
    id: d.id,
    title: d.body.goal,
    chip: d.verified ? { tone: 'ok', text: 'Verified' } : { tone: 'danger', text: 'Failed' },
    detail: (
      <>
        <Fact label="Done when">{d.body.doneCondition}</Fact>
        <Fact label="Quest reported done">{d.body.met ? 'yes' : 'no'}</Fact>
        {d.verified ? (
          <p>Every check passed.</p>
        ) : (
          <>
            <p>
              <strong>Failed checks</strong>
            </p>
            <ul>
              {d.failedChecks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
      </>
    ),
  }
}

function bugRow(b: MailBugReport): Row {
  return {
    id: b.id,
    title: b.title,
    chip: { tone: BUG_TONE[b.status], text: b.status },
    detail: (
      <>
        <Fact label="Status">{b.status}</Fact>
        <Fact label="Steps">{b.reproduction.steps}</Fact>
        <Fact label="Should happen">{b.reproduction.expected}</Fact>
        <Fact label="Happens">{b.reproduction.actual}</Fact>
        {b.fixQuestId !== null && (
          <p>
            <a href={`/quests?quest=${encodeURIComponent(b.fixQuestId)}`}>Fix Quest</a>
          </p>
        )}
      </>
    ),
  }
}

/**
 * The Guild Master's Mailbox: what passes between Halls. Inquiries (a question and its answer),
 * Dossiers (the checks a finished Quest's records passed or failed) and Bug Reports (a
 * reproduction, its status and its Fix Quest), a Hall at a time, a page at a time, refetched when
 * the guild's live stream says one changed. Every word a Member wrote is rendered as text only.
 */
export function MailboxPanel({ session }: { session: Session | null }) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [hallId, setHallId] = useState('')
  const [tab, setTab] = useState<TabId>('inquiries')
  const [status, setStatus] = useState<BugStatus | ''>('')
  const [rows, setRows] = useState<Row[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', steps: '', expected: '', actual: '', quest: '' })
  const changed = mailboxCount(useLiveEvents())

  useEffect(() => {
    if (!session) {
      setRoster(null)
      return
    }
    loadRoster(session, fetch)
      .then((loaded) => {
        setRoster(loaded)
        const asked = new URLSearchParams(window.location.search).get('hall')
        setHallId(
          (current) =>
            current ||
            loaded.halls.find((h) => !h.locked && h.id === asked)?.id ||
            (loaded.halls.find((h) => !h.locked)?.id ?? '')
        )
      })
      .catch(() => setFailed(true))
  }, [session])

  const hallName = useCallback(
    (id: string): string => roster?.halls.find((h) => h.id === id)?.name ?? id,
    [roster]
  )

  const page = useCallback(
    async (after?: number): Promise<{ rows: Row[]; next: number | null }> => {
      if (!session) {
        return { rows: [], next: null }
      }
      const query = { limit: PAGE, ...(after === undefined ? {} : { after }) }
      if (tab === 'inquiries') {
        const got = await loadInquiries(session, fetch, hallId, query)
        return { rows: got.inquiries.map((i) => inquiryRow(i, hallName)), next: got.next }
      }
      if (tab === 'dossiers') {
        const got = await loadDossiers(session, fetch, hallId, query)
        return { rows: got.dossiers.map(dossierRow), next: got.next }
      }
      const got = await loadBugReports(session, fetch, hallId, {
        ...query,
        ...(status === '' ? {} : { status }),
      })
      return { rows: got.reports.map(bugRow), next: got.next }
    },
    [session, hallId, tab, status, hallName]
  )

  const refresh = useCallback(() => {
    if (!session || hallId === '') {
      setRows([])
      setNext(null)
      return () => {}
    }
    let live = true
    page()
      .then((got) => {
        if (live) {
          setRows(got.rows)
          setNext(got.next)
          setFailed(false)
        }
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [session, hallId, page])
  useEffect(() => refresh(), [refresh])
  const seen = useRef(changed)
  useEffect(() => {
    if (seen.current === changed) {
      return
    }
    seen.current = changed
    return refresh()
  }, [changed, refresh])

  const older = async () => {
    if (next === null) {
      return
    }
    try {
      const got = await page(next)
      setRows((all) => [...all, ...got.rows])
      setNext(got.next)
    } catch {
      setFailed(true)
    }
  }

  const choose = (id: TabId) => {
    setTab(id)
    setOpenId(null)
    setRefusal(null)
    setDone(null)
  }
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = (send: () => Promise<string>) => async (e: FormEvent) => {
    e.preventDefault()
    setRefusal(null)
    setDone(null)
    try {
      setDone(await send())
      refresh()
    } catch (error) {
      setRefusal(mailboxRefusal(error))
    }
  }
  const file = submit(async () => {
    if (!session) {
      return ''
    }
    const filed = await fileBugReport(session, fetch, {
      owningHall: hallId,
      title: form.title,
      reproduction: { steps: form.steps, expected: form.expected, actual: form.actual },
    })
    return filed.fixQuestId === null
      ? 'Filed as a duplicate of a Bug Report already open.'
      : `Filed. A Fix Quest is on the ${hallName(hallId)} Quest Board.`
  })
  const request = submit(async () => {
    if (!session) {
      return ''
    }
    await requestDossier(session, fetch, form.quest.trim())
    return 'The Dossier is made and sits in the mailbox.'
  })

  const halls = roster?.halls.filter((h) => !h.locked) ?? []
  const opened = rows.find((row) => row.id === openId) ?? null
  return (
    <WorkSection id="mailbox" title="Mailbox">
      {!session && <p>Sign in with a passkey to open the Mailbox.</p>}
      {failed && <p role="alert">The mailbox could not be read.</p>}
      {session && (
        <div role="tablist" aria-label="Mailbox" className="mt-4 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <PixelButton
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => choose(t.id)}
            >
              {t.label}
            </PixelButton>
          ))}
        </div>
      )}
      {session && (halls.length > 0 || tab === 'bugs') && (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          {halls.length > 0 && (
            <label htmlFor="mailbox-hall" className="flex items-center gap-2">
              Hall
              <select
                id="mailbox-hall"
                name="mailbox-hall"
                value={hallId}
                onChange={(e) => {
                  setHallId(e.target.value)
                  setOpenId(null)
                }}
              >
                {halls.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {tab === 'bugs' && (
            <label htmlFor="mailbox-status" className="flex items-center gap-2">
              Status
              <select
                id="mailbox-status"
                name="mailbox-status"
                value={status}
                onChange={(e) => {
                  const picked = e.target.value
                  setStatus(
                    picked === 'open' || picked === 'duplicate' || picked === 'fixed' ? picked : ''
                  )
                }}
              >
                <option value="">All</option>
                <option value="open">Open</option>
                <option value="duplicate">Duplicate</option>
                <option value="fixed">Fixed</option>
              </select>
            </label>
          )}
        </div>
      )}
      {session && rows.length === 0 && !failed && (
        <p className="muted mt-4">Nothing in this part of the mailbox yet.</p>
      )}
      {opened !== null ? (
        <section aria-label="Mail" data-testid="mail-detail" className="work-note mt-4">
          <h3>
            <Badge tone={opened.chip.tone}>{opened.chip.text}</Badge> {opened.title}
          </h3>
          {opened.detail}
          <PixelButton className="mt-2" onClick={() => setOpenId(null)}>
            Back to the list
          </PixelButton>
        </section>
      ) : (
        rows.length > 0 && (
          <ul
            aria-label={TABS.find((t) => t.id === tab)?.label}
            className="mt-4 flex flex-col gap-2"
          >
            {rows.map((row) => (
              <li key={row.id} data-testid="mail-row" className="flex flex-wrap items-center gap-2">
                <Badge tone={row.chip.tone}>{row.chip.text}</Badge>
                <span className="flex-1">{row.title}</span>
                <PixelButton onClick={() => setOpenId(row.id)}>Open</PixelButton>
              </li>
            ))}
          </ul>
        )
      )}
      {next !== null && opened === null && (
        <PixelButton className="mt-4" onClick={older}>
          Load older
        </PixelButton>
      )}
      {session && tab === 'bugs' && (
        <form className="mt-4 flex flex-col gap-2" onSubmit={file}>
          <h3>File a Bug Report with {hallName(hallId)}</h3>
          <label htmlFor="bug-title">Title</label>
          <input id="bug-title" name="bug-title" value={form.title} onChange={set('title')} />
          <label htmlFor="bug-steps">Steps</label>
          <textarea id="bug-steps" name="bug-steps" value={form.steps} onChange={set('steps')} />
          <label htmlFor="bug-expected">What should happen</label>
          <textarea
            id="bug-expected"
            name="bug-expected"
            value={form.expected}
            onChange={set('expected')}
          />
          <label htmlFor="bug-actual">What happens</label>
          <textarea
            id="bug-actual"
            name="bug-actual"
            value={form.actual}
            onChange={set('actual')}
          />
          <PixelButton type="submit">File Bug Report</PixelButton>
        </form>
      )}
      {session && tab === 'dossiers' && (
        <form className="mt-4 flex flex-col gap-2" onSubmit={request}>
          <h3>Request a Dossier</h3>
          <label htmlFor="dossier-quest">Finished Quest id</label>
          <input
            id="dossier-quest"
            name="dossier-quest"
            value={form.quest}
            onChange={set('quest')}
          />
          <PixelButton type="submit">Request Dossier</PixelButton>
        </form>
      )}
      {refusal !== null && <p role="alert">{refusal}</p>}
      {done !== null && <p role="status">{done}</p>}
    </WorkSection>
  )
}
