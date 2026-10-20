import { type DragEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { Fetcher } from '../artifacts'
import { loadGates } from '../gates'
import { type PasskeyBrowser, type Session, webAuthnBrowser } from '../passkeys'
import { loadTripwires } from '../tripwires'
import {
  type ConfigIssue,
  confirmVersion,
  loadCurrent,
  loadVersions,
  restoreVersion,
  type SaveOutcome,
  SaveRejected,
  saveConfig,
  type VersionRow,
} from './api'
import { Canvas, PIECE_TYPE } from './Canvas'
import { issuesByNode, type Overlays } from './graph'
import { Inspector } from './Inspector'
import { addHall, addMember, type BuilderConfig, moveMember } from './model'
import { Outline } from './Outline'
import { instantiate, TEMPLATES } from './templates'

/** Props of {@link BuilderPanel}. */
export interface BuilderPanelProps {
  session: Session
  fetcher?: Fetcher
  browser?: PasskeyBrowser
  /** Forces the desktop canvas (true) or the phone's read-only tree (false); default follows the screen width. */
  desktop?: boolean
}

// One stable function: a fresh default per render would re-run the loading effect forever.
const liveFetch: Fetcher = (url, init) => fetch(url, init)

const WIDE = '(min-width: 768px)'

const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(WIDE) : null)

function useDesktop(forced: boolean | undefined): boolean {
  const [wide, setWide] = useState(() => query()?.matches ?? true)
  useEffect(() => {
    const list = query()
    if (!list) {
      return
    }
    const onChange = () => setWide(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return forced ?? wide
}

const noOverlays: Overlays = { pausedHalls: new Set(), barred: false }
const noIssues: ReadonlyMap<string, string[]> = new Map()

function startDrag(piece: string) {
  return (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(PIECE_TYPE, piece)
    event.dataTransfer.effectAllowed = 'copy'
  }
}

/** The Guild builder: a drag-and-drop canvas for Halls and Members, saved as versioned config. */
export function BuilderPanel({
  session,
  fetcher = liveFetch,
  browser = webAuthnBrowser,
  desktop,
}: BuilderPanelProps) {
  const wide = useDesktop(desktop)
  const [saved, setSaved] = useState<BuilderConfig | null>(null)
  const [draft, setDraft] = useState<BuilderConfig | null>(null)
  const [version, setVersion] = useState(0)
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [overlays, setOverlays] = useState<Overlays>(noOverlays)
  const [selected, setSelected] = useState<string | null>(null)
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [pending, setPending] = useState<SaveOutcome | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const current = await loadCurrent(session, fetcher)
    setSaved(current.config)
    setDraft(current.config)
    setVersion(current.version)
    setVersions(await loadVersions(session, fetcher).catch(() => []))
  }, [session, fetcher])

  useEffect(() => {
    let live = true
    reload().catch(() => live && setFailed('The guild config could not be loaded.'))
    Promise.all([
      loadTripwires(session, fetcher).catch(() => null),
      loadGates(session, fetcher).catch(() => null),
    ]).then(([tripwires, gates]) => {
      if (live) {
        setOverlays({
          pausedHalls: new Set(tripwires?.pauses.map((p) => p.hallId)),
          barred: Boolean(gates?.guild || gates?.global),
        })
      }
    })
    return () => {
      live = false
    }
  }, [session, fetcher, reload])

  const issueMap = useMemo(() => (draft ? issuesByNode(draft, issues) : noIssues), [draft, issues])

  if (!draft || !saved) {
    return (
      <section aria-labelledby="builder-heading" className="card">
        <h2 id="builder-heading" className="card-title">
          Guild builder
        </h2>
        {failed ? <p role="alert">{failed}</p> : <p className="muted">Loading...</p>}
      </section>
    )
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const edit = (next: BuilderConfig) => {
    setDraft(next)
    setIssues([])
    setMessage(null)
    setFailed(null)
  }
  const dropPiece = (piece: string, hallId: string | null) => {
    if (piece === 'hall') {
      const next = addHall(draft, 'New Hall')
      edit(next)
      setSelected(next.halls.at(-1)?.id ?? null)
    } else if (piece === 'member') {
      const target = hallId ?? selectedHall(draft, selected)
      if (target) {
        edit(addMember(draft, target))
      } else {
        setMessage('Drop a Member onto a Hall, or select a Hall first.')
      }
    } else if (piece.startsWith('template:')) {
      const template = TEMPLATES.find((t) => `template:${t.id}` === piece)
      if (template) {
        const next = instantiate(draft, template)
        edit(next)
        setSelected(next.halls.at(-1)?.id ?? null)
      }
    }
  }

  const report = async (outcome: SaveOutcome) => {
    if (outcome.status === 'pending') {
      setPending(outcome)
      setMessage(null)
      return
    }
    setPending(null)
    await reload()
    setMessage(`Saved as version ${outcome.version} (${outcome.change}).`)
  }
  const attempt = async (run: () => Promise<void>) => {
    setFailed(null)
    try {
      await run()
    } catch (error) {
      if (error instanceof SaveRejected) {
        setIssues(error.issues)
        setFailed('The server refused this config. See the marked nodes.')
      } else {
        setFailed(`The change was refused (${error instanceof Error ? error.message : 'unknown'}).`)
      }
    }
  }
  const save = () =>
    attempt(async () => {
      setIssues([])
      await report(await saveConfig(session, draft, fetcher))
    })
  const confirm = () =>
    attempt(async () => {
      if (pending) {
        await confirmVersion(session, pending.version, fetcher, browser)
        setPending(null)
        await reload()
        setMessage(`Version ${pending.version} is confirmed and in force.`)
      }
    })
  const restore = (row: VersionRow) =>
    attempt(async () => report(await restoreVersion(session, row.version, fetcher)))

  return (
    <section aria-labelledby="builder-heading" className="card builder">
      <h2 id="builder-heading" className="card-title">
        Guild builder
      </h2>
      <p className="muted">Steward, Halls, Captains and Members. Version {version} is in force.</p>
      {!wide && (
        <>
          <p className="muted" role="note">
            This is a read-only outline of the guild. To change it, edit on a desktop.
          </p>
          <Outline config={draft} overlays={overlays} issues={issueMap} />
        </>
      )}
      {wide && (
        <>
          <fieldset className="actions builder-palette">
            <legend className="sr-only">Palette</legend>
            <button
              type="button"
              draggable
              onDragStart={startDrag('hall')}
              onClick={() => dropPiece('hall', null)}
            >
              Add blank Hall
            </button>
            <button
              type="button"
              draggable
              onDragStart={startDrag('member')}
              onClick={() => dropPiece('member', null)}
            >
              Add blank Member
            </button>
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                draggable
                onDragStart={startDrag(`template:${t.id}`)}
                onClick={() => dropPiece(`template:${t.id}`, null)}
              >
                {`Add ${t.label}`}
              </button>
            ))}
          </fieldset>
          <div className="builder-body">
            <Canvas
              config={draft}
              overlays={overlays}
              issues={issueMap}
              selected={selected}
              onSelect={setSelected}
              onMove={(id, to) => edit(moveMember(draft, id, to))}
              onDropPiece={dropPiece}
            />
            <Inspector config={draft} selected={selected} onChange={edit} onSelect={setSelected} />
          </div>
          <details open className="builder-outline">
            <summary>Outline (keyboard access to every node)</summary>
            <Outline
              config={draft}
              overlays={overlays}
              issues={issueMap}
              selected={selected}
              onSelect={setSelected}
            />
          </details>
          <div className="actions builder-save">
            <p role="status" className={dirty ? 'unsaved' : 'muted'}>
              {dirty ? 'Unsaved changes' : 'No unsaved changes'}
            </p>
            <button type="button" className="btn-primary" disabled={!dirty} onClick={save}>
              Save
            </button>
            <button type="button" disabled={!dirty} onClick={() => edit(saved)}>
              Discard
            </button>
          </div>
          {pending && (
            <div role="alert" className="builder-pending">
              <p>
                Version {pending.version} is a {pending.change} change, so it is stored but not in
                force until you confirm it with your passkey.
              </p>
              <button type="button" className="btn-primary" onClick={confirm}>
                Confirm with passkey
              </button>
            </div>
          )}
          {message && <p role="status">{message}</p>}
          {failed && (
            <p role="alert" className="error-text">
              {failed}
            </p>
          )}
          <section aria-labelledby="history-heading">
            <h3 id="history-heading" className="sub-title">
              Version history
            </h3>
            <ul aria-label="Versions">
              {versions.map((row) => (
                <li key={row.version} className="item">
                  Version {row.version}: {row.kind}, {row.change}, {row.status}{' '}
                  <button type="button" onClick={() => restore(row)}>
                    {`Restore version ${row.version}`}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  )
}

function selectedHall(config: BuilderConfig, selected: string | null): string | null {
  const hall = config.halls.find(
    (h) =>
      h.id === selected || h.members.some((m) => m.id === selected) || h.captain?.id === selected
  )
  return hall?.id ?? null
}
