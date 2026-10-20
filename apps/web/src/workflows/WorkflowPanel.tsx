import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'
import type { Fetcher } from '../artifacts'
import { Badge } from '../Badge'
import { loadCurrent } from '../builder/api'
import { Palette } from '../builder/Palette'
import { formatDollars, loadCosts } from '../costs'
import { type PasskeyBrowser, type Session, webAuthnBrowser } from '../passkeys'
import { fetchStreamTicket, loadQuests, questStreamUrl } from '../quests'
import { createBackoff, streamHandlers, streamNotice } from '../stream-retry'
import { WorkSection } from '../WorkSection'
import {
  confirmWorkflowVersion,
  listRuns,
  listWorkflows,
  loadRunState,
  loadVersions,
  loadWorkflow,
  type RunState,
  runWorkflow,
  type SaveOutcome,
  saveWorkflow,
  type VersionDoc,
  validateGraph,
  WorkflowRejected,
  type WorkflowSummary,
} from './api'
import { Canvas, NODE_PIECE } from './Canvas'
import { Inspector } from './Inspector'
import { layout, type Place } from './layout'
import { addNode, connect, paletteTypes, saveBody, versionLine } from './model'
import {
  errorsByNode,
  type NodeOverlay,
  readRunFrame,
  runOverlay,
  type WorkflowIssue,
} from './overlay'

/** Props of {@link WorkflowPanel}. */
export interface WorkflowPanelProps {
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

const STARTER: WorkflowGraph = { nodes: [{ id: 'start', type: 'trigger.manual' }], edges: [] }
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
      <button type="button" aria-pressed={selected} onClick={() => onSelect(id)}>
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

/** The Workflows view: a drag-and-drop canvas to design, save, run and watch Workflows. */
export function WorkflowPanel({
  session,
  fetcher = liveFetch,
  browser = webAuthnBrowser,
  desktop,
  validateDelayMs = 400,
  live = true,
}: WorkflowPanelProps) {
  const wide = useDesktop(desktop)
  const [list, setList] = useState<WorkflowSummary[]>([])
  const [id, setId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState<WorkflowGraph | null>(null)
  const [draft, setDraft] = useState<WorkflowGraph | null>(null)
  const [version, setVersion] = useState(0)
  const [activeVersion, setActiveVersion] = useState<number | null>(null)
  const [versions, setVersions] = useState<VersionDoc[]>([])
  const [halls, setHalls] = useState<{ id: string; name: string }[]>([])
  const [positions, setPositions] = useState<ReadonlyMap<string, Place>>(noPlaces)
  const [selected, setSelected] = useState<string | null>(null)
  const [issues, setIssues] = useState<WorkflowIssue[]>([])
  const [pending, setPending] = useState<SaveOutcome | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [newId, setNewId] = useState('')
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<RunState | null>(null)
  const [overlay, setOverlay] = useState<ReadonlyMap<string, NodeOverlay>>(noOverlay)

  const open = useCallback(
    async (workflowId: string) => {
      const loaded = await loadWorkflow(session, workflowId, fetcher)
      setId(workflowId)
      setPositions(noPlaces)
      setSelected(null)
      setIssues([])
      setPending(null)
      setMessage(null)
      setRunId(null)
      setRun(null)
      setOverlay(noOverlay)
      if (!loaded) {
        setName(workflowId)
        setSaved(null)
        setDraft(STARTER)
        setVersion(0)
        setActiveVersion(null)
        setVersions([])
        return
      }
      setName(loaded.version.name)
      setSaved(loaded.version.graph)
      setDraft(loaded.version.graph)
      setVersion(loaded.version.version)
      setActiveVersion(loaded.activeVersion)
      setVersions(await loadVersions(session, workflowId, fetcher).catch(() => []))
      // Coming back to a Workflow shows its newest run, so leaving the view does not lose the overlay.
      const runs = await listRuns(session, workflowId, fetcher).catch(() => [])
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
    listWorkflows(session, fetcher)
      .then((found) => {
        if (!alive) {
          return
        }
        setList(found)
        const first = found[0]
        if (first) {
          return open(first.id)
        }
        setId('my-workflow')
        setName('My workflow')
        setDraft(STARTER)
      })
      .catch(() => alive && setFailed('The Workflows could not be loaded.'))
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
      <WorkSection id="workflows" title="Workflows">
        {failed ? <p role="alert">{failed}</p> : <p>Loading...</p>}
      </WorkSection>
    )
  }

  const dirty = saved === null || JSON.stringify(draft) !== JSON.stringify(saved)
  const edit = (next: WorkflowGraph) => {
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
      if (error instanceof WorkflowRejected) {
        setIssues(error.errors)
        setFailed('The server refused this Workflow. See the marked nodes.')
      } else {
        setFailed(`The change was refused (${error instanceof Error ? error.message : 'unknown'}).`)
      }
    }
  }
  const afterSave = async (outcome: SaveOutcome) => {
    const refreshed = await listWorkflows(session, fetcher).catch(() => list)
    setList(refreshed)
    if (outcome.status === 'pending') {
      setPending(outcome)
      setMessage(null)
      const stored = await loadVersions(session, id, fetcher).catch(() => versions)
      setVersions(stored)
      setSaved(draft)
      setVersion(outcome.version)
      return
    }
    setPending(null)
    await open(id)
    setMessage(`Saved as version ${outcome.version} (${outcome.classification}); it is in force.`)
  }
  const save = () =>
    attempt(async () => afterSave(await saveWorkflow(session, id, saveBody(name, draft), fetcher)))
  const confirm = () =>
    attempt(async () => {
      if (pending) {
        await confirmWorkflowVersion(session, id, pending.version, fetcher, browser)
        setPending(null)
        await open(id)
        setMessage(`Version ${pending.version} is confirmed and in force.`)
      }
    })
  const restore = (row: VersionDoc) =>
    attempt(async () =>
      afterSave(await saveWorkflow(session, id, saveBody(row.name, row.graph), fetcher))
    )
  const startRun = () =>
    attempt(async () => {
      const outcome = await runWorkflow(session, id, fetcher, crypto.randomUUID())
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
  const create = () => {
    if (ID_SLUG.test(newId)) {
      setId(newId)
      setName(newId)
      setSaved(null)
      setDraft(STARTER)
      setVersion(0)
      setActiveVersion(null)
      setVersions([])
      setPositions(noPlaces)
      setSelected(null)
      setNewId('')
      setPending(null)
      setRunId(null)
      setRun(null)
      setOverlay(noOverlay)
    } else {
      setFailed('A Workflow id is lowercase letters, digits, - or _, starting with a letter.')
    }
  }

  const canRun = activeVersion !== null && !dirty && !pending
  const labelOf = (nodeId: string) => draft.nodes.find((n) => n.id === nodeId)?.name ?? nodeId

  return (
    <section aria-labelledby="workflows-heading" className="card builder workflows">
      <h2 id="workflows-heading" className="card-title">
        Workflows
      </h2>
      {streamNotice(streamFailures) !== null && <p role="status">{streamNotice(streamFailures)}</p>}
      <div className="actions">
        <label>
          Workflow
          <select
            aria-label="Workflow"
            value={list.some((w) => w.id === id) ? id : ''}
            onChange={(e) => {
              if (e.target.value) {
                open(e.target.value).catch(() => setFailed('That Workflow could not be loaded.'))
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
        {wide && (
          <>
            <label>
              New Workflow id
              <input value={newId} onChange={(e) => setNewId(e.target.value)} />
            </label>
            <button type="button" onClick={create}>
              Create Workflow
            </button>
          </>
        )}
        <button type="button" className="btn-primary" disabled={!canRun} onClick={startRun}>
          Run
        </button>
      </div>
      <p className="muted">
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
            Save
          </button>
          <button
            type="button"
            disabled={!dirty || saved === null}
            onClick={() => saved && edit(saved)}
          >
            Discard
          </button>
        </div>
      )}
      {pending && (
        <div role="alert" className="builder-pending">
          <p>
            Version {pending.version} is a {pending.classification} change, so it is stored but not
            in force until you confirm it with your passkey.
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
          {versions.map((row) => (
            <li key={row.version} className="item">
              Version {row.version}: {row.classification}, {row.status}{' '}
              {wide && (
                <button type="button" onClick={() => restore(row)}>
                  {`Restore version ${row.version}`}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </section>
  )
}
