import { useEffect, useState } from 'react'
import { Badge, sealTone } from './Badge'
import { PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import { enablePush } from './push'
import {
  decideSeal,
  getSeal,
  type InboxSeal,
  listSeals,
  markPosted,
  releaseStale,
  sealIdFromSearch,
} from './seals'

/**
 * The Seal inbox: each pending Seal shows its exact text, evidence and hash. The Guild Master
 * stamps it with the passkey (or denies it with a note), then copies the text and marks it posted.
 */
export function SealPanel({ session }: { session: Session | null }) {
  const [seals, setSeals] = useState<InboxSeal[]>([])
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')

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

  // A tapped push notification opens the ledger at `?seal=<id>`: that Seal is fetched by id and shown first.
  const focusId = sealIdFromSearch(window.location.search)

  const refresh = async (current: Session) => {
    const waiting = (await listSeals(current, fetch)).seals
    const approved = (await listSeals(current, fetch, 20, 'approved')).seals
    const reserved = (await listSeals(current, fetch, 20, 'reserved')).seals
    const all = [...waiting, ...approved, ...reserved.filter((s) => s.stale)]
    const linked = focusId ? all.find((s) => s.id === focusId) : undefined
    if (focusId && !linked) {
      all.unshift(await getSeal(current, focusId, fetch))
    }
    setSeals(all)
  }

  useEffect(() => {
    if (!session || !focusId) {
      return
    }
    let live = true
    getSeal(session, focusId, fetch)
      .then((seal) => {
        if (live) {
          setSeals((all) => [seal, ...all.filter((s) => s.id !== seal.id)])
        }
      })
      .catch(() => {
        if (live) {
          setMessage('The linked Seal could not be loaded')
        }
      })
    return () => {
      live = false
    }
  }, [session, focusId])

  function replace(updated: InboxSeal) {
    setSeals((all) => all.map((s) => (s.id === updated.id ? updated : s)))
  }

  return (
    <section aria-labelledby="seals-heading" className="card">
      <h2 id="seals-heading" className="card-title">
        Seal inbox
      </h2>
      {session ? (
        <div className="mt-4 flex flex-col gap-3">
          <button type="button" onClick={() => run('Load Seals', refresh)}>
            Load Seals
          </button>
          <button
            type="button"
            onClick={() =>
              run('Enable push', async (current) => {
                const registration = await navigator.serviceWorker.ready
                const result = await enablePush(current, {
                  fetcher: fetch,
                  push: registration.pushManager,
                  permission: () => Notification.requestPermission(),
                })
                if (result !== 'enabled') {
                  throw new Error(result)
                }
              })
            }
          >
            Notify me of new Seals
          </button>
          <ul aria-label="Seals" className="flex flex-col gap-3">
            {seals.map((seal) => (
              <li key={seal.id} className="item">
                <p className="whitespace-pre-wrap">{seal.text}</p>
                <p className="mt-2 text-sm">Evidence: {seal.evidence}</p>
                <p className="break-all text-xs">Hash: {seal.actionHash}</p>
                <p>
                  <Badge tone={sealTone(seal.status)}>{seal.status}</Badge>
                </p>
                {seal.status === 'requested' ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <label htmlFor={`note-${seal.id}`}>Note (if denying)</label>
                    <input
                      id={`note-${seal.id}`}
                      value={notes[seal.id] ?? ''}
                      onChange={(event) => setNotes({ ...notes, [seal.id]: event.target.value })}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="btn-primary flex-1"
                        onClick={() =>
                          run('Stamp', async (current) =>
                            replace(
                              await decideSeal(
                                current,
                                seal,
                                'approved',
                                undefined,
                                fetch,
                                webAuthnBrowser
                              )
                            )
                          )
                        }
                      >
                        Stamp with passkey
                      </button>
                      <button
                        type="button"
                        className="flex-1"
                        onClick={() =>
                          run('Deny', async (current) =>
                            replace(
                              await decideSeal(
                                current,
                                seal,
                                'denied',
                                notes[seal.id]?.trim() || undefined,
                                fetch,
                                webAuthnBrowser
                              )
                            )
                          )
                        }
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ) : null}
                {seal.stale ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <p className="text-sm">
                      A publish started and never finished. Release only if nothing was posted.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="flex-1"
                        onClick={() =>
                          run('Release stale', async (current) =>
                            replace(await releaseStale(current, seal, fetch, webAuthnBrowser))
                          )
                        }
                      >
                        Release (nothing posted)
                      </button>
                      <button
                        type="button"
                        className="btn-primary flex-1"
                        onClick={() =>
                          run('Mark posted', async (current) =>
                            replace(await markPosted(current, seal, fetch, webAuthnBrowser))
                          )
                        }
                      >
                        Mark posted
                      </button>
                    </div>
                  </div>
                ) : null}
                {seal.status === 'approved' ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="flex-1"
                      onClick={() => run('Copy', () => navigator.clipboard.writeText(seal.text))}
                    >
                      Copy text
                    </button>
                    <button
                      type="button"
                      className="btn-primary flex-1"
                      onClick={() =>
                        run('Mark posted', async (current) =>
                          replace(await markPosted(current, seal, fetch, webAuthnBrowser))
                        )
                      }
                    >
                      Mark posted
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p role="status" aria-live="polite">
            {message}
          </p>
        </div>
      ) : (
        <p className="mt-4">Sign in with a passkey to use the Seal inbox.</p>
      )}
    </section>
  )
}
