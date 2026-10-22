import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import type { Fetcher } from '../artifacts'
import { confirmVersion, loadCurrent } from '../builder/api'
import type { BuilderConfig } from '../builder/model'
import { type PasskeyBrowser, type Session, webAuthnBrowser } from '../passkeys'
import { EmptyState, PixelButton, YesNo } from '../ui/pixel'
import { WorkSection } from '../WorkSection'
import { CharterRefused, exportCharter, importCharter } from './api'
import './charter.css'
import { type CharterPreview, previewCharter } from './diff'
import { type Charter, CharterFileError, parseCharter } from './schema'

/** Props of {@link CharterPanel}. */
export interface CharterPanelProps {
  session: Session
  fetcher?: Fetcher
  browser?: PasskeyBrowser
  /** Saves the exported file; defaults to a browser download. */
  download?: (filename: string, text: string) => void
}

// One stable function: a fresh default per render would re-run the loading effect forever.
const liveFetch: Fetcher = (url, init) => fetch(url, init)

/** Saves `text` as a file through a temporary link. */
function browserDownload(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** A file name safe on every system, from the guild's name. */
function fileName(name: string): string {
  const safe = [...name]
    .filter((c) => c.charCodeAt(0) >= 32)
    .join('')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim()
  return `${safe || 'guild'}.charter.json`
}

function reasonFor(error: unknown): string {
  if (error instanceof CharterRefused) {
    if (error.status === 413) {
      return 'The Charter is too large (256 KB at most). Nothing was changed.'
    }
    if (error.status === 409 && error.code === 'import_id_reused') {
      return 'This import was already used for a different Charter. Try the import again. Nothing was changed.'
    }
    if (error.code === 'invalid_charter') {
      return 'This file is not a Charter this guild can read. Nothing was changed.'
    }
    if (error.code === 'subscription_disabled') {
      return 'Charters need the Subscription, and the Subscription is off for this guild. Nothing was changed.'
    }
    if (error.code === 'seal_policy_locked') {
      return 'The Seal Policy is locked on this guild, so this Charter cannot change it. Nothing was changed.'
    }
    if (error.code === 'invalid_request') {
      return 'The import request could not be understood. Try the import again. Nothing was changed.'
    }
    return `The server refused this Charter (${error.code}). Nothing was changed.`
  }
  return `The import failed (${error instanceof Error ? error.message : 'unknown'}). Nothing was changed.`
}

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) {
    return null
  }
  const seen = new Map<string, number>()
  const keyed = items.map((item) => {
    const n = seen.get(item) ?? 0
    seen.set(item, n + 1)
    return { item, key: `${item}#${n}` }
  })
  return (
    <>
      <h4 className="sub-title">{label}</h4>
      <ul aria-label={label} className="charter-list">
        {keyed.map(({ item, key }) => (
          <li key={key} className="item">
            {item}
          </li>
        ))}
      </ul>
    </>
  )
}

function Preview({ preview }: { preview: CharterPreview }) {
  const none =
    preview.hallsAdded.length +
      preview.hallsRemoved.length +
      preview.settings.length +
      preview.ritesAdded.length ===
    0
  return (
    <div className="charter-preview">
      <h3 className="sub-title">What this Charter will change</h3>
      {none && <p className="muted">Nothing: this guild already matches.</p>}
      <List label="Halls added" items={preview.hallsAdded} />
      <List label="Halls removed" items={preview.hallsRemoved} />
      <List
        label="Caps, Seal Policy and other settings"
        items={preview.settings.map((s) => `${s.label}: ${s.from} -> ${s.to}`)}
      />
      <List
        label="Rites added as drafts (they run only once published)"
        items={preview.ritesAdded}
      />
      <List label="Kept from this guild" items={preview.kept} />
      <p className="muted">
        A change that widens what your agents may do waits for your passkey before it takes effect.
      </p>
    </div>
  )
}

/** The Charter page: export the guild, or import a Charter with a preview first. */
export function CharterPanel({
  session,
  fetcher = liveFetch,
  browser = webAuthnBrowser,
  download = browserDownload,
}: CharterPanelProps) {
  const [current, setCurrent] = useState<{ version: number; config: BuilderConfig } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [omitted, setOmitted] = useState<Charter['omitted'] | null>(null)
  const [charter, setCharter] = useState<Charter | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [pendingVersion, setPendingVersion] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const importId = useRef<string>(crypto.randomUUID())

  const reload = useCallback(async () => {
    setCurrent(await loadCurrent(session, fetcher))
  }, [session, fetcher])

  useEffect(() => {
    let live = true
    reload().catch(() => live && setLoadFailed(true))
    return () => {
      live = false
    }
  }, [reload])

  const doExport = async () => {
    setFailed(null)
    setMessage(null)
    try {
      const out = await exportCharter(session, fetcher)
      download(fileName(out.name), JSON.stringify(out))
      setOmitted(out.omitted)
      setMessage(`Exported ${fileName(out.name)}.`)
    } catch (error) {
      setFailed(
        `The Charter could not be exported (${error instanceof Error ? error.message : 'unknown'}).`
      )
    }
  }

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setMessage(null)
    setFailed(null)
    setStale(false)
    setPendingVersion(null)
    setAsking(false)
    if (!file) {
      return
    }
    try {
      setCharter(parseCharter(await file.text()))
      setFileError(null)
      importId.current = crypto.randomUUID()
    } catch (error) {
      setCharter(null)
      setFileError(
        error instanceof CharterFileError
          ? `This is not a valid Charter: ${error.message}`
          : 'This is not a valid Charter: the file could not be read.'
      )
    }
  }

  const answer = async (yes: boolean) => {
    setAsking(false)
    if (!yes || !charter || !current) {
      return
    }
    setBusy(true)
    setFailed(null)
    setMessage(null)
    try {
      const result = await importCharter(
        session,
        { charter, baseVersion: current.version, importId: importId.current },
        fetcher
      )
      const made = `${result.riteIds.length} Rite draft${result.riteIds.length === 1 ? '' : 's'} added.`
      if (result.config.outcome === 'pending') {
        setPendingVersion(result.config.version)
        setMessage(
          `Imported. ${made} The config change widens authority: version ${result.config.version} waits for your passkey.`
        )
      } else {
        setMessage(
          result.config.outcome === 'applied'
            ? `Imported. The config is now version ${result.config.version}. ${made}`
            : `Imported. The config already matched. ${made}`
        )
        await reload()
      }
      setCharter(null)
      importId.current = crypto.randomUUID()
    } catch (error) {
      if (error instanceof CharterRefused && error.status === 409 && error.code === 'stale') {
        setStale(true)
        setFailed(
          'The guild config changed since you loaded it. Reload to see the latest, then import again. Nothing was changed.'
        )
      } else {
        setFailed(reasonFor(error))
      }
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (pendingVersion === null) {
      return
    }
    setFailed(null)
    try {
      await confirmVersion(session, pendingVersion, fetcher, browser)
      setMessage(`Version ${pendingVersion} is confirmed and in force.`)
      setPendingVersion(null)
      await reload()
    } catch (error) {
      setFailed(
        `The change was not confirmed (${error instanceof Error ? error.message : 'unknown'}).`
      )
    }
  }

  const reloadLatest = async () => {
    setFailed(null)
    try {
      await reload()
      setStale(false)
    } catch {
      setFailed('The guild config could not be reloaded.')
    }
  }

  if (!current) {
    return (
      <WorkSection id="charter" title="Charter">
        {loadFailed ? <p role="alert">The guild config could not be loaded.</p> : <p>Loading...</p>}
      </WorkSection>
    )
  }

  const preview = charter ? previewCharter(current.config, charter) : null

  return (
    <WorkSection id="charter" title="Charter">
      <p className="muted">
        A Charter is your guild's structure in one file, without secrets, private routing
        attestations or your repo list. Importing one never grants authority on its own.
      </p>
      <section aria-labelledby="charter-export" className="charter-block">
        <h3 id="charter-export" className="sub-title">
          Export
        </h3>
        <PixelButton onClick={doExport}>Export Charter</PixelButton>
        {omitted && omitted.length === 0 && <p className="muted">Nothing was left out.</p>}
        {omitted && omitted.length > 0 && (
          <>
            <h4 className="sub-title">Left out of the file</h4>
            <ul aria-label="Left out of the file" className="charter-list">
              {omitted.map((o) => (
                <li key={`${o.kind}:${o.id}`} className="item">
                  {o.kind} {o.id}: {o.reason}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section aria-labelledby="charter-import" className="charter-block">
        <h3 id="charter-import" className="sub-title">
          Import
        </h3>
        <p className="muted">Config version {current.version} is in force.</p>
        <label className="charter-file">
          Charter file
          <input type="file" accept=".json,application/json" onChange={onFile} />
        </label>
        {fileError && (
          <p role="alert" className="error-text">
            {fileError}
          </p>
        )}
        {!charter && !fileError && !message && (
          <EmptyState
            member="steward"
            line="Pick a .charter.json file to see what it would change."
          />
        )}
        {charter && preview && (
          <>
            <Preview preview={preview} />
            {asking ? (
              <fieldset className="charter-confirm">
                <YesNo
                  safe="no"
                  safeFirst
                  question={`Import ${charter.name} into this guild? Rites arrive as drafts.`}
                  onAnswer={answer}
                />
              </fieldset>
            ) : (
              <PixelButton disabled={busy} onClick={() => setAsking(true)}>
                Import this Charter
              </PixelButton>
            )}
          </>
        )}
        {message && <p role="status">{message}</p>}
        {pendingVersion !== null && (
          <PixelButton onClick={confirm}>Confirm with passkey</PixelButton>
        )}
        {failed && (
          <p role="alert" className="error-text">
            {failed}
          </p>
        )}
        {stale && <PixelButton onClick={reloadLatest}>Reload</PixelButton>}
      </section>
    </WorkSection>
  )
}
