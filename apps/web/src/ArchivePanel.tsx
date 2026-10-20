import { useState } from 'react'
import {
  type ArchiveNote,
  type ArchiveNoteDetail,
  addNote,
  listNotes,
  readNote,
  searchNotes,
} from './archive'
import { PasskeyRequestError, type Session } from './passkeys'

/** The Archive screen: add text or link notes, search them, and read versions and backlinks. */
export function ArchivePanel({ session }: { session: Session | null }) {
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

  const find = (current: Session) =>
    (query.trim() ? searchNotes(current, query, fetch) : listNotes(current, fetch)).then((page) =>
      setNotes(page.notes)
    )

  return (
    <section aria-labelledby="archive-heading" className="card">
      <h2 id="archive-heading" className="card-title">
        Archive
      </h2>
      {session ? (
        <div className="mt-4 flex flex-col gap-2">
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
            <button type="submit" className="btn-primary" disabled={!title.trim() || !body}>
              Add note
            </button>
          </form>
          <label htmlFor="note-search">Search notes</label>
          <div className="flex gap-2">
            <input
              id="note-search"
              className="flex-1"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" onClick={() => run('Search', find)}>
              Search
            </button>
          </div>
          <ul aria-label="Notes">
            {notes.map((note) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="underline"
                  onClick={() =>
                    run('Open note', async (current) =>
                      setDetail(await readNote(current, note.id, fetch))
                    )
                  }
                >
                  {note.title}
                </button>{' '}
                <span className="text-sm">
                  {note.trust === 'fact' ? 'fact' : 'quarantined assumption'}, v{note.version}
                </span>
              </li>
            ))}
          </ul>
          {detail ? (
            <article aria-label="Note detail">
              <h3 className="font-semibold">{detail.note.title}</h3>
              <p className="whitespace-pre-wrap">{detail.note.body}</p>
              {detail.note.evidence ? <p>Evidence: {detail.note.evidence}</p> : null}
              <h4 className="mt-2 font-semibold">Backlinks</h4>
              <ul aria-label="Backlinks">
                {detail.backlinks.map((link) => (
                  <li key={link.id}>{link.title}</li>
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
          <p role="status" aria-live="polite">
            {message}
          </p>
        </div>
      ) : (
        <p className="mt-4">Sign in with a passkey to use the Archive.</p>
      )}
    </section>
  )
}
