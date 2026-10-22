import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RiteGraph } from '../../../guildd/src/rites/graph'
import type { Fetcher } from '../artifacts'
import { Badge } from '../Badge'
import { loadCurrent } from '../builder/api'
import { Palette } from '../builder/Palette'
import { formatDollars, loadCosts } from '../costs'
import {
  type PasskeyBrowser,
  PasskeyRequestError,
  type Session,
  webAuthnBrowser,
} from '../passkeys'
import { fetchStreamTicket, loadQuests, questStreamUrl } from '../quests'
import { createBackoff, streamHandlers, streamNotice } from '../stream-retry'
import { EmptyState, PixelButton, YesNo } from '../ui/pixel'
import { WorkSection } from '../WorkSection'
import {
  archiveRite,
  confirmRiteVersion,
  listRites,
  listRuns,
  loadRite,
  loadRunState,
  loadVersions,
  publishRite,
  RiteRejected,
  type RiteSummary,
  type RunState,
  runRite,
  type SaveOutcome,
  saveRite,
  unarchiveRite,
  type VersionDoc,
  validateGraph,
} from './api'
import { Canvas, NODE_PIECE } from './Canvas'
import { describeDiff, diffGraphs } from './diff'
import { Inspector } from './Inspector'
import { layout, type Place } from './layout'
import {
  addNode,
  connect,
  isStalePending,
  paletteTypes,
  riteChip,
  saveBody,
  versionLine,
} from './model'
import { errorsByNode, type NodeOverlay, type RiteIssue, readRunFrame, runOverlay } from './overlay'
import { SaveQueue } from './saveQueue'

/** Props of {@link RitePanel}. */
export interface RitePanelProps {
  session: Session
  fetcher?: Fetcher
  browser?: PasskeyBrowser
  /** Forces the desktop editor (true) or the phone's read-only view (false); default follows the screen width. */
  desktop?: boolean
  /** Wait before the draft is sent to the validate route, in ms. */
  validateDelayMs?: number
  /** Whether to follow the live event stream (off in tests). */
  live?: boolean
}

// One stable function: a fresh default per render would re-run the loading effects forever.
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

const STARTER: RiteGraph = { nodes: [{ id: 'start', type: 'trigger.manual' }], edges: [] }
const ID_SLUG = /^[a-z][a-z0-9_-]{0,63}$/
const POLL_MS = 4000
const noPlaces: ReadonlyMap<string, Place> = new Map()
const noOverlay: ReadonlyMap<string, NodeOverlay> = new Map()
const TERMINAL = new Set(['done', 'failed', 'passed', 'approved', 'rejected'])

/**
 * Follows the guild event stream and calls `onRefresh` for events that can move a run. Returns the
 * failed attempts in a row, for the in-world notice.
 */
function useRunStream(session: Session, enabled: boolean, onRefresh: () => void): number {
  const [failures, setFailures] = useState(0)
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh
  useEffect(() => {
    if (!enabled) {
      return
    }
    let closed = false
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const backoff = createBackoff()
    let lastSeq = 0
    let burst: ReturnType<typeof setTimeout> | undefined
    const retry = () => {
      if (!closed) {
        const { wait, failures: count } = backoff.next(Math.random())
        setFailures(count)
        timer = setTimeout(connect, wait)
      }
    }
    const connect = async () => {
      const ticket = await fetchStreamTicket(session, liveFetch).catch(() => null)
      if (closed) {
        return
      }
      if (ticket === null) {
        retry()
        return
      }
      socket = new WebSocket(questStreamUrl(session, window.location.origin, lastSeq, ticket))
      // Only a received frame resets the backoff: a socket that upgrades then drops still fails.
      const handlers = streamHandlers(backoff, {
        onHealthy: () => setFailures(0),
        onMessage: (data) => {
          const read = readRunFrame(data)
          if (read.seq !== null) {
            lastSeq = Math.max(lastSeq, read.seq)
          }
          if (read.refresh) {
            // One reload per burst: a reconnect replays many events at once.
            clearTimeout(burst)
            burst = setTimeout(() => refresh.current(), 250)
          }
        },
        onRetry: (wait, count) => {
          if (!closed) {
            setFailures(count)
            timer = setTimeout(connect, wait)
          }
        },
      })
      socket.onmessage = (message) => handlers.message(String(message.data))
      socket.onclose = handlers.close
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      clearTimeout(burst)
      socket?.close()
    }
  }, [session, enabled])
  return failures
}

function OutlineRow({
  id,
  label,
  type,
  issues,
  overlay,
  selected,
  onSelect,
}: {
  id: string
  label: string
  type: string
  issues: string[]
  overlay: NodeOverlay | undefined
  selected: boolean
  onSelect: (id: string) => void
}) {
  return (
    <li data-node-id={id} className="item">
      <button
        type="button"
        aria-label={`Step: ${label}`}
        aria-pressed={selected}
        onClick={() => onSelect(id)}
      >
        {label}
      </button>{' '}
      <span className="muted">{type}</span>
      {overlay && (
        <>
          {' '}
          <Badge tone={overlay.tone}>{overlay.text}</Badge>
          {overlay.attempts !== null && <span>{` ${overlay.attempts} attempts`}</span>}
          {overlay.costMicros !== null && <span>{` ${formatDollars(overlay.costMicros)}`}</span>}
        </>
      )}
      {issues.map((message) => (
        <p key={message} role="alert" className="error-text node-issue">
          {message}
        </p>
      ))}
    </li>
  )
}

/** The Rites view: a drag-and-drop canvas to design, save, run and watch Rites. */
export function RitePanel({
  session,
  fetcher = liveFetch,
  browser = webAuthnBrowser,
  desktop,
  validateDelayMs = 400,
  live = true,
}: RitePanelProps) {
  const wide = useDesktop(desktop)
  const [list, setList] = useState<RiteSummary[]>([])
  const [id, setId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState<RiteGraph | null>(null)
  const [draft, setDraft] = useState<RiteGraph | null>(null)
  const [version, setVersion] = useState(0)
  const [status, setStatus] = useState<VersionDoc['status'] | null>(null)
  // The viewed version waits on a version that is no longer in force, so no confirm can succeed.
  const [staleView, setStaleView] = useState(false)
  const [activeVersion, setActiveVersion] = useState<number | null>(null)
  const [versions, setVersions] = useState<VersionDoc[]>([])
  const [expanded, setExpanded] = useState<number[]>([])
  const [fetchedActive, setFetchedActive] = useState<VersionDoc | null>(null)
  const [halls, setHalls] = useState<{ id: string; name: string }[]>([])
  const [positions, setPositions] = useState<ReadonlyMap<string, Place>>(noPlaces)
  const [selected, setSelected] = useState<string | null>(null)
  const [issues, setIssues] = useState<RiteIssue[]>([])
  const [pending, setPending] = useState<SaveOutcome | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [newId, setNewId] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<RunState | null>(null)
  const [overlay, setOverlay] = useState<ReadonlyMap<string, NodeOverlay>>(noOverlay)
  const [showArchived, setShowArchived] = useState(false)
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [empty, setEmpty] = useState(false)
  const [refocus, setRefocus] = useState(false)
  const archiveButton = useRef<HTMLButtonElement>(null)
  const current = useRef({ session, fetcher })
  current.current = { session, fetcher }
  // One queue per Rite: its saves go one at a time and a queued save a newer one supersedes is dropped.
  const saveQueues = useRef(
    new Map<string, SaveQueue<{ name: string; graph: RiteGraph }, SaveOutcome>>()
  )

  const open = useCallback(
    async (riteId: string) => {
      const loaded = await loadRite(session, riteId, fetcher)
      setId(riteId)
      setPositions(noPlaces)
      setSelected(null)
      setIssues([])
      setPending(null)
      setMessage(null)
      setExpanded([])
      setFetchedActive(null)
      setRunId(null)
      setRun(null)
      setOverlay(noOverlay)
      if (!loaded) {
        setName(riteId)
        setSavedName(null)
        setSaved(null)
        setDraft(STARTER)
        setVersion(0)
        setStatus(null)
        setActiveVersion(null)
        setVersions([])
        return
      }
      setStatus(loaded.version.status)
      const stale = isStalePending(loaded.version, loaded.activeVersion)
      setStaleView(stale)
      if (loaded.version.status === 'pending' && !stale) {
        setPending({
          version: loaded.version.version,
          status: 'pending',
          classification: loaded.version.classification,
        })
      }
      setName(loaded.version.name)
      setSavedName(loaded.version.name)
      setEmpty(false)
      setSaved(loaded.version.graph)
      setDraft(loaded.version.graph)
      setVersion(loaded.version.version)
      setActiveVersion(loaded.activeVersion)
      const page = await loadVersions(session, riteId, fetcher).catch(() => [])
      setVersions(page)
      if (loaded.activeVersion !== null && !page.some((v) => v.version === loaded.activeVersion)) {
        const found = await loadRite(session, riteId, fetcher, loaded.activeVersion).catch(
          () => null
        )
        setFetchedActive(found?.version ?? null)
      }
      // Coming back to a Rite shows its newest run, so leaving the view does not lose the overlay.
      const runs = await listRuns(session, riteId, fetcher).catch(() => [])
      const newest = runs.reduce<(typeof runs)[number] | null>(
        (best, r) => (best === null || r.createdAt > best.createdAt ? r : best),
        null
      )
      setRunId(newest?.id ?? null)
    },
    [session, fetcher]
  )

  useEffect(() => {
    let alive = true
    listRites(session, fetcher)
      .then((found) => {
        if (!alive) {
          return
        }
        setList(found)
        const first = found[0]
        if (first) {
          return open(first.id)
        }
        setId('my-rite')
        setName('My Rite')
        setDraft(STARTER)
        setEmpty(true)
      })
      .catch(() => alive && setFailed('The Rites could not be loaded.'))
    loadCurrent(session, fetcher)
      .then(
        (current) =>
          alive && setHalls(current.config.halls.map((h) => ({ id: h.id, name: h.name })))
      )
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [session, fetcher, open])

  // The server is the authority: the draft goes to the validate route, and its errors are shown.
  useEffect(() => {
    if (!(id && draft)) {
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      validateGraph(session, id, draft, fetcher)
        .then((errors) => alive && setIssues(errors))
        .catch(() => undefined)
    }, validateDelayMs)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [session, fetcher, id, draft, validateDelayMs])

  const refreshRun = useCallback(async () => {
    if (!(id && runId)) {
      return
    }
    const state = await loadRunState(session, id, runId, fetcher).catch(() => null)
    if (!state) {
      return
    }
    const [quests, costs] = await Promise.all([
      loadQuests(session, fetcher).catch(() => []),
      loadCosts(session, 'quest', fetcher).catch(() => []),
    ])
    setRun(state)
    setOverlay(
      runOverlay(
        state.nodes,
        new Map(quests.map((q) => [q.id, q.attempts])),
        new Map(costs.map((c) => [c.key, c.costMicros]))
      )
    )
  }, [session, fetcher, id, runId])

  useEffect(() => {
    refreshRun()
  }, [refreshRun])
  const streamFailures = useRunStream(session, live && runId !== null, refreshRun)
  const running = run?.nodes.some((n) => !TERMINAL.has(n.status))
  useEffect(() => {
    if (!(live && running)) {
      return
    }
    const timer = setInterval(refreshRun, POLL_MS)
    return () => clearInterval(timer)
  }, [live, running, refreshRun])

  useEffect(() => {
    if (refocus && !confirmingArchive) {
      archiveButton.current?.focus()
      setRefocus(false)
    }
  }, [refocus, confirmingArchive])

  const split = useMemo(() => errorsByNode(issues), [issues])
  const places = useMemo(() => {
    const merged = new Map(draft ? layout(draft) : [])
    for (const [key, place] of positions) {
      if (merged.has(key)) {
        merged.set(key, place)
      }
    }
    return merged
  }, [draft, positions])

  if (!draft || !id) {
    return (
      <WorkSection id="rites" title="Rites">
        {failed ? <p role="alert">{failed}</p> : <p>Loading...</p>}
      </WorkSection>
    )
  }

  const dirty =
    saved === null || JSON.stringify(draft) !== JSON.stringify(saved) || name !== savedName
  const edit = (next: RiteGraph) => {
    setDraft(next)
    setMessage(null)
    setFailed(null)
  }
  const dropType = (type: string, place?: Place) => {
    const next = addNode(draft, type)
    const added = next.nodes.at(-1)
    edit(next)
    if (added && next.nodes.length > draft.nodes.length) {
      setSelected(added.id)
      if (place) {
        setPositions(new Map(positions).set(added.id, place))
      }
    }
  }

  const attempt = async (action: () => Promise<void>) => {
    setFailed(null)
    try {
      await action()
    } catch (error) {
      if (error instanceof RiteRejected) {
        setIssues(error.errors)
        setFailed('The server refused this Rite. See the marked nodes.')
      } else {
        setFailed(`The change was refused (${error instanceof Error ? error.message : 'unknown'}).`)
      }
    }
  }
  const afterSave = async (outcome: SaveOutcome, fromSave = false) => {
    setList(await listRites(session, fetcher).catch(() => list))
    await open(id)
    setMessage(
      fromSave && outcome.status === 'active'
        ? `Version ${outcome.version} is already in force and unchanged.`
        : fromSave && outcome.status === 'superseded'
          ? `Version ${outcome.version} is unchanged.`
          : outcome.status === 'draft'
            ? `Saved as draft version ${outcome.version} (${outcome.classification}). Publish it to put it in force.`
            : outcome.status === 'pending'
              ? null
              : `Version ${outcome.version} is published and in force.`
    )
  }
  const queuedSave = (riteId: string, body: { name: string; graph: RiteGraph }) => {
    let queue = saveQueues.current.get(riteId)
    if (!queue) {
      queue = new SaveQueue((input) =>
        saveRite(
          current.current.session,
          riteId,
          { ...input, saveId: crypto.randomUUID() },
          current.current.fetcher
        )
      )
      saveQueues.current.set(riteId, queue)
    }
    return queue.enqueue(body)
  }
  const save = () =>
    attempt(async () => afterSave(await queuedSave(id, saveBody(name, draft)), true))
  const publish = () =>
    attempt(async () => {
      try {
        const outcome = await publishRite(session, id, version, activeVersion, fetcher)
        await afterSave(outcome)
      } catch (error) {
        if (error instanceof PasskeyRequestError && error.code === 'stale') {
          setFailed(
            'This Rite changed since you opened it, so nothing was published. Reload it to see the live version.'
          )
          return
        }
        throw error
      }
    })
  const confirm = () =>
    attempt(async () => {
      if (pending) {
        await confirmRiteVersion(session, id, pending.version, fetcher, browser)
        setPending(null)
        await open(id)
        setMessage(`Version ${pending.version} is confirmed and in force.`)
      }
    })
  const restore = (row: VersionDoc) =>
    attempt(async () => afterSave(await queuedSave(id, saveBody(row.name, row.graph)), true))
  const startRun = () =>
    attempt(async () => {
      const outcome = await runRite(session, id, fetcher, crypto.randomUUID())
      if (outcome.ok) {
        setRunId(outcome.instanceId)
        setMessage('Run started.')
        return
      }
      if (outcome.errors) {
        setIssues(outcome.errors)
      }
      setFailed(
        `The run was refused (${outcome.error}${outcome.nodeId ? ` at ${outcome.nodeId}` : ''}).`
      )
    })
  const reload = async (archived: boolean) => {
    const found = await listRites(session, fetcher, archived)
    setList(found)
    setShowArchived(archived)
    setConfirmingArchive(false)
    const first = found[0]
    if (first) {
      await open(first.id)
      return
    }
    if (archived) {
      // No archived Rites: the empty state shows, and the selected Rite and editor stay as they are.
      return
    }
    // Nothing left to show: fall back to the blank starter, as a guild with no Rites does.
    setId('my-rite')
    setName('My Rite')
    setSaved(null)
    setSavedName(null)
    setEmpty(true)
    setDraft(STARTER)
    setVersion(0)
    setStatus(null)
    setActiveVersion(null)
    setVersions([])
    setRunId(null)
    setRun(null)
    setOverlay(noOverlay)
  }
  const archive = () =>
    attempt(async () => {
      await archiveRite(session, id, fetcher)
      setMessage(null)
      await reload(false)
    })
  const unarchive = () =>
    attempt(async () => {
      await unarchiveRite(session, id, fetcher)
      await reload(false)
      setMessage('Rite restored. It must be published again to be in force.')
    })
  const toggleArchived = (archived: boolean) =>
    attempt(async () => {
      await reload(archived)
    })
  const create = () => {
    if (ID_SLUG.test(newId)) {
      setId(newId)
      setName(newId)
      setSaved(null)
      setSavedName(null)
      setEmpty(false)
      setDraft(STARTER)
      setVersion(0)
      setStatus(null)
      setActiveVersion(null)
      setVersions([])
      setExpanded([])
      setFetchedActive(null)
      setPositions(noPlaces)
      setSelected(null)
      setNewId('')
      setPending(null)
      setRunId(null)
      setRun(null)
      setOverlay(noOverlay)
    } else {
      setFailed('A Rite id is lowercase letters, digits, - or _, starting with a letter.')
    }
  }

  const archivedEmpty = showArchived && list.length === 0
  const archivedView = showArchived && list.some((w) => w.id === id)
  const canRun =
    activeVersion !== null && !dirty && !pending && status === 'active' && !archivedView
  const labelOf = (nodeId: string) => draft.nodes.find((n) => n.id === nodeId)?.name ?? nodeId

  return (
    <section aria-labelledby="rites-heading" className="card builder rites">
      <h2 id="rites-heading" className="card-title">
        Rites
      </h2>
      {streamNotice(streamFailures) !== null && <p role="status">{streamNotice(streamFailures)}</p>}
      <div className="actions">
        {!empty && !archivedEmpty && (
          <label>
            Rite
            <select
              aria-label="Rite"
              value={list.some((w) => w.id === id) ? id : ''}
              onChange={(e) => {
                if (e.target.value) {
                  open(e.target.value).catch(() => setFailed('That Rite could not be loaded.'))
                }
              }}
            >
              {!list.some((w) => w.id === id) && <option value="">{`${id} (unsaved)`}</option>}
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {wide && (
          <>
            <label>
              New Rite id
              <input value={newId} onChange={(e) => setNewId(e.target.value)} />
            </label>
            <button type="button" onClick={create}>
              Create Rite
            </button>
          </>
        )}
        <button
          type="button"
          className="btn-primary"
          disabled={!canRun || archivedEmpty}
          onClick={startRun}
        >
          Run
        </button>
        <PixelButton onClick={() => toggleArchived(!showArchived)}>
          <span className="px-cursor" aria-hidden="true">
            {showArchived ? '\u25B6' : '\u25B7'}
          </span>
          {showArchived ? 'Hide archived' : 'Show archived'}
        </PixelButton>
        {wide && archivedView && (
          <button type="button" onClick={unarchive}>
            Unarchive
          </button>
        )}
        {wide && !archivedView && !archivedEmpty && version > 0 && !confirmingArchive && (
          <button ref={archiveButton} type="button" onClick={() => setConfirmingArchive(true)}>
            Archive
          </button>
        )}
      </div>
      {confirmingArchive && (
        <fieldset
          className="rite-confirm"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
            }
          }}
        >
          <YesNo
            safe="no"
            safeFirst
            question={`Archive ${savedName ?? name}? It leaves the list and cannot run until restored.`}
            onAnswer={(yes) => {
              if (yes) {
                archive()
              } else {
                setConfirmingArchive(false)
                setRefocus(true)
              }
            }}
          />
        </fieldset>
      )}
      {archivedEmpty ? (
        <EmptyState
          member="steward"
          line="No archived Rites. Everything is in the list."
          actionLabel="Back to Rites"
          onAction={() => toggleArchived(false)}
        />
      ) : empty ? (
        <EmptyState member="steward" line="No Rites yet. Name a new Rite id above to start one." />
      ) : (
        <>
          <p className="muted">
            <span
              data-testid="rite-chip"
              className={`badge ${riteChip(staleView ? 'draft' : status, dirty) === 'Live' ? 'badge-ok' : 'badge-warn'}`}
            >
              {riteChip(staleView ? 'draft' : status, dirty)}
            </span>{' '}
            {version === 0 ? 'Not saved yet.' : versionLine(version, activeVersion)}
          </p>
          {wide && (
            <Palette
              label="Palette"
              pieces={paletteTypes().map((type) => ({
                id: type,
                label: `Add ${type}`,
                glyph: type.replace(/^trigger\./, '').slice(0, 4),
              }))}
              dragType={NODE_PIECE}
              onAdd={dropType}
            />
          )}
          {split.graphLevel.length > 0 && (
            <ul aria-label="Graph problems">
              {split.graphLevel.map((text) => (
                <li key={text} role="alert" className="error-text">
                  {text}
                </li>
              ))}
            </ul>
          )}
          <div className="builder-body">
            <Canvas
              graph={draft}
              places={places}
              issues={split.byNode}
              overlay={overlay}
              selected={selected}
              readOnly={!wide}
              onSelect={setSelected}
              onConnect={(from, to) => edit(connect(draft, from, to))}
              onMove={(nodeId, place) => setPositions(new Map(positions).set(nodeId, place))}
              onDropType={dropType}
            />
            {wide && (
              <Inspector
                graph={draft}
                selected={selected}
                halls={halls}
                onChange={edit}
                onSelect={setSelected}
              />
            )}
          </div>
          <details open className="builder-outline">
            <summary>Nodes (keyboard access to every node)</summary>
            <ul className="outline" aria-label="Nodes">
              {draft.nodes.map((n) => (
                <OutlineRow
                  key={n.id}
                  id={n.id}
                  label={labelOf(n.id)}
                  type={n.type}
                  issues={split.byNode.get(n.id) ?? []}
                  overlay={overlay.get(n.id)}
                  selected={selected === n.id}
                  onSelect={setSelected}
                />
              ))}
            </ul>
          </details>
          {wide && (
            <div className="actions builder-save">
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <p role="status" className={dirty ? 'unsaved' : 'muted'}>
                {dirty ? 'Unsaved changes' : 'No unsaved changes'}
              </p>
              <button type="button" className="btn-primary" disabled={!dirty} onClick={save}>
                Save draft
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={dirty || status !== 'draft'}
                onClick={publish}
              >
                Publish
              </button>
              <button
                type="button"
                disabled={!dirty || saved === null}
                onClick={() => {
                  if (saved) {
                    edit(saved)
                  }
                  if (savedName !== null) {
                    setName(savedName)
                  }
                }}
              >
                Discard
              </button>
            </div>
          )}
          {pending && (
            <div role="alert" className="builder-pending">
              <p>
                Version {pending.version} is a {pending.classification} change, so it is stored but
                not in force until you confirm it with your passkey.
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
          <section aria-labelledby="wf-history-heading">
            <h3 id="wf-history-heading" className="sub-title">
              Version history
            </h3>
            <ul aria-label="Versions">
              {versions.map((row) => {
                const open = expanded.includes(row.version)
                const active = versions.find((v) => v.version === activeVersion) ?? fetchedActive
                const lines =
                  active && active.version !== row.version
                    ? describeDiff(diffGraphs(active.graph, row.graph))
                    : []
                return (
                  <li key={row.version} className="item">
                    Version {row.version}:{' '}
                    {isStalePending(row, activeVersion)
                      ? 'stale \u2014 save and publish a new draft to change this Rite'
                      : `${row.classification}, ${row.status}`}{' '}
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setExpanded(
                          open
                            ? expanded.filter((v) => v !== row.version)
                            : [...expanded, row.version]
                        )
                      }
                    >
                      {`${open ? 'Hide' : 'Show'} changes in version ${row.version}`}
                    </button>{' '}
                    {wide && (
                      <button type="button" onClick={() => restore(row)}>
                        {`Restore version ${row.version}`}
                      </button>
                    )}
                    {open && (
                      <ul aria-label={`Changes in version ${row.version}`} className="muted">
                        {row.version === activeVersion ? (
                          <li>This is the version in force.</li>
                        ) : !active ? (
                          <li>No version is in force yet, so there is nothing to compare.</li>
                        ) : lines.length === 0 ? (
                          <li>No changes from the version in force.</li>
                        ) : (
                          lines.map((line) => <li key={line}>{line}</li>)
                        )}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </section>
  )
}
