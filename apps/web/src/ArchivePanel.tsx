import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { parseWikiLinks, titleKey } from '../../guildd/src/ports/note-store'
import {
  type ArchiveExport,
  type ArchiveNote,
  type ArchiveNoteDetail,
  addNote,
  exportArchive,
  listNotes,
  readNote,
  searchNotes,
} from './archive'
import type { Fetcher } from './artifacts'
import { type PasskeyBrowser, PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

// One stable function: a fresh default per render would be a new prop every time.
const liveFetch: Fetcher = (url, init) => fetch(url, init)

/** Saves the zip through a temporary link. */
function browserDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** The badge a private note wears in the list and the header. */
function PrivateBadge() {
  return <span className="text-sm font-semibold">PRIVATE</span>
}

/** The body as text, with each `[[link]]` to a known note as a button that opens it. */
function linkedBody(
  body: string,
  idOf: (key: string) => string | undefined,
  open: (id: string) => void
): ReactNode[] {
  const out: ReactNode[] = []
  let from = 0
  for (const link of parseWikiLinks(body, (key) => idOf(key) !== undefined)) {
    const id = idOf(titleKey(link.target))
    if (id === undefined) {
      continue
    }
    out.push(<Fragment key={`t${from}`}>{body.slice(from, link.start)}</Fragment>)
    out.push(
      <PixelButton key={link.start} onClick={() => open(id)}>
        {link.alias ?? link.target}
      </PixelButton>
    )
    from = link.end
  }
  out.push(<Fragment key={`t${from}`}>{body.slice(from)}</Fragment>)
  return out
}

const notes = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`

/** The plain-language outcome of an export. */
function outcomeLine(counts: ArchiveExport['counts']): string {
  return counts.privateIncluded > 0
    ? `Exported ${notes(counts.exported)}, ${counts.privateIncluded} of them private.`
    : `Exported ${notes(counts.exported)}; ${counts.privateLeftOut} private ${counts.privateLeftOut === 1 ? 'note' : 'notes'} left out.`
}

/** A plain message for a refused or failed export. */
function exportFailure(error: unknown): string {
  if (!(error instanceof PasskeyRequestError)) {
    return 'The export failed. Try again.'
  }
  if (error.status === 401) {
    return 'Sign in again to export the Archive.'
  }
  if (error.status === 403) {
    return 'Confirm with your passkey to include private notes, then try again.'
  }
  if (error.status === 413) {
    return 'The Archive is too large to export in one zip.'
  }
  if (error.status === 429) {
    return 'Too many exports. Wait a moment and try again.'
  }
  return `The export was refused: ${error.code}.`
}

/** The Archive screen: add text or link notes, search them, and read versions and backlinks. */
export function ArchivePanel({
  session,
  fetcher = liveFetch,
  browser = webAuthnBrowser,
  download = browserDownload,
}: {
  session: Session | null
  fetcher?: Fetcher
  browser?: PasskeyBrowser
  download?: (filename: string, blob: Blob) => void
}) {
  const [includePrivate, setIncludePrivate] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<'text' | 'link'>('text')
  const [claim, setClaim] = useState<'fact' | 'assumption'>('assumption')
  const [evidence, setEvidence] = useState('')
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [notes, setNotes] = useState<ArchiveNote[]>([])
  const [detail, setDetail] = useState<ArchiveNoteDetail | null>(null)

  async function run(label: string, action: (current: Session) => Promise<void>) {
    if (!session) {
      return
    }
    setMessage(`${label}...`)
    try {
      await action(session)
      setMessage(`${label}: done`)
    } catch (error) {
      setMessage(
        error instanceof PasskeyRequestError ? `${label} refused: ${error.code}` : `${label} failed`
      )
    }
  }

  useEffect(() => {
    if (message) {
      statusRef.current?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [message])

  async function runExport(current: Session) {
    if (exportingRef.current) {
      return
    }
    exportingRef.current = true
    setExporting(true)
    setMessage('Exporting...')
    try {
      const out = await exportArchive(current, includePrivate, fetcher, browser)
      download(out.filename, out.blob)
      setMessage(outcomeLine(out.counts))
    } catch (error) {
      setMessage(exportFailure(error))
    } finally {
      exportingRef.current = false
      setExporting(false)
      setIncludePrivate(false)
    }
  }

  const openNote = (id: string) =>
    run('Open note', async (current) => setDetail(await readNote(current, id, fetch)))
  const idByTitle = (key: string) => notes.find((n) => titleKey(n.title) === key)?.id

  const find = (current: Session) =>
    (query.trim() ? searchNotes(current, query, fetch) : listNotes(current, fetch)).then((page) =>
      setNotes(page.notes)
    )

  return (
    <WorkSection id="archive" title="Notes">
      {session ? (
        <div className="work-body">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              run('Add note', async (current) => {
                await addNote(
                  current,
                  {
                    kind,
                    title: title.trim(),
                    body,
                    claim,
                    ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
                  },
                  fetch
                )
                setTitle('')
                setBody('')
                setEvidence('')
                await find(current)
              })
            }}
          >
            <label htmlFor="note-kind">Kind</label>
            <select
              id="note-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value === 'link' ? 'link' : 'text')}
            >
              <option value="text">Text</option>
              <option value="link">Link</option>
            </select>
            <label htmlFor="note-title">Title</label>
            <input
              id="note-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <label htmlFor="note-body">
              {kind === 'link' ? 'URL' : 'Note (use [[Title]] to link)'}
            </label>
            <textarea
              id="note-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <label htmlFor="note-claim">Trust</label>
            <select
              id="note-claim"
              value={claim}
              onChange={(event) => setClaim(event.target.value === 'fact' ? 'fact' : 'assumption')}
            >
              <option value="assumption">Assumption (quarantined)</option>
              <option value="fact">Fact (needs evidence)</option>
            </select>
            {claim === 'fact' ? (
              <>
                <label htmlFor="note-evidence">Evidence</label>
                <input
                  id="note-evidence"
                  value={evidence}
                  onChange={(event) => setEvidence(event.target.value)}
                />
              </>
            ) : null}
            <PixelButton type="submit" disabled={!title.trim() || !body}>
              Add note
            </PixelButton>
          </form>
          <div className="flex flex-wrap gap-2">
            <PixelButton
              aria-pressed={includePrivate}
              onClick={() => setIncludePrivate((on) => !on)}
            >
              Include private notes
            </PixelButton>
            <PixelButton disabled={exporting} onClick={() => runExport(session)}>
              Export archive
            </PixelButton>
          </div>
          <p className="text-sm">
            {includePrivate
              ? 'Private notes will be included; your passkey confirms it.'
              : 'Private notes stay out of the export.'}
          </p>
          <label htmlFor="note-search">Search notes</label>
          <div className="flex gap-2">
            <input
              id="note-search"
              className="flex-1"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <PixelButton onClick={() => run('Search', find)}>Search</PixelButton>
          </div>
          <ul aria-label="Notes" className="work-log">
            {notes.map((note) => (
              <li key={note.id}>
                <PixelButton onClick={() => openNote(note.id)}>{note.title}</PixelButton>{' '}
                {note.dataClass === 'private' ? <PrivateBadge /> : null}{' '}
                <span className="text-sm">
                  {note.trust === 'fact' ? 'fact' : 'quarantined assumption'}, v{note.version}
                </span>
              </li>
            ))}
          </ul>
          {detail ? (
            <article aria-label="Note detail" className="work-note">
              <h3 className="font-semibold">
                {detail.note.title} {detail.note.dataClass === 'private' ? <PrivateBadge /> : null}
              </h3>
              <p className="whitespace-pre-wrap">
                {linkedBody(detail.note.body, idByTitle, openNote)}
              </p>
              {detail.note.evidence ? <p>Evidence: {detail.note.evidence}</p> : null}
              <h4 className="mt-2 font-semibold">Backlinks</h4>
              <ul aria-label="Backlinks">
                {detail.backlinks.map((link) => (
                  <li key={link.id}>
                    <PixelButton onClick={() => openNote(link.id)}>{link.title}</PixelButton>
                  </li>
                ))}
              </ul>
              <h4 className="mt-2 font-semibold">Versions</h4>
              <ol aria-label="Versions">
                {detail.versions.map((v) => (
                  <li key={v.version}>
                    v{v.version}: {v.title}
                  </li>
                ))}
              </ol>
            </article>
          ) : null}
          <p ref={statusRef} role="status" aria-live="polite">
            {message}
          </p>
        </div>
      ) : (
        <p>Sign in with a passkey to use the Archive.</p>
      )}
    </WorkSection>
  )
}
