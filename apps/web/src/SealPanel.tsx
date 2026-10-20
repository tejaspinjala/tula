import { useCallback, useEffect, useState } from 'react'
import { Badge, sealTone } from './Badge'
import { shortenId } from './GuildId'
import { PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import { enablePush } from './push'
import { loadQuests } from './quests'
import {
  decideSeal,
  getSeal,
  type InboxSeal,
  listSeals,
  markPosted,
  parseEvidence,
  releaseStale,
  sealIdFromSearch,
  sealStatusLabel,
} from './seals'

function Evidence({ evidence }: { evidence: string }) {
  const { lead, items } = parseEvidence(evidence)
  return (
    <div className="mt-2 text-sm">
      <p className="muted">{lead ? `Evidence: ${lead}` : 'Evidence'}</p>
      <ul aria-label="Evidence" className="evidence-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The Seal inbox: each pending Seal shows its Quest, exact text, evidence and hash. The Guild
 * Master stamps it with the passkey (or denies it with a note), then copies the text, posts it
 * and confirms it was posted.
 */
export function SealPanel({ session }: { session: Session | null }) {
  const [seals, setSeals] = useState<InboxSeal[]>([])
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<string | null>(null)
  const [postUrl, setPostUrl] = useState('')
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

  const refresh = useCallback(
    async (current: Session) => {
      const waiting = (await listSeals(current, fetch)).seals
      const approved = (await listSeals(current, fetch, 20, 'approved')).seals
      const reserved = (await listSeals(current, fetch, 20, 'reserved')).seals
      const all = [...waiting, ...approved, ...reserved.filter((s) => s.stale)]
      const linked = focusId ? all.find((s) => s.id === focusId) : undefined
      if (focusId && !linked) {
        all.unshift(await getSeal(current, focusId, fetch))
      }
      setSeals(all)
      // Quest titles are a nicety: a Seal still shows without them.
      loadQuests(current, fetch)
        .then((quests) => setTitles(Object.fromEntries(quests.map((q) => [q.id, q.title]))))
        .catch(() => undefined)
    },
    [focusId]
  )

  // The inbox loads when the view opens: nobody has to press a button to see what is waiting.
  useEffect(() => {
    if (!session) {
      return
    }
    refresh(session).catch(() => setMessage('The Seals could not be loaded.'))
  }, [session, refresh])

  function replace(updated: InboxSeal) {
    setSeals((all) => all.map((s) => (s.id === updated.id ? updated : s)))
  }

  function markPostedButton(seal: InboxSeal) {
    return (
      <button type="button" className="btn-primary flex-1" onClick={() => setConfirming(seal.id)}>
        Mark posted
      </button>
    )
  }

  function confirmPosted(seal: InboxSeal) {
    return (
      <div className="mt-2 flex flex-col gap-2">
        <p>Confirm you posted this exact text by hand. It cannot be undone.</p>
        <label htmlFor={`url-${seal.id}`}>Post URL (optional)</label>
        <input
          id={`url-${seal.id}`}
          name="post-url"
          type="url"
          inputMode="url"
          value={postUrl}
          onChange={(event) => setPostUrl(event.target.value)}
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary flex-1"
            onClick={() =>
              run('Mark posted', async (current) => {
                replace(await markPosted(current, seal, fetch, webAuthnBrowser))
                setConfirming(null)
                setPostUrl('')
              })
            }
          >
            Confirm: I posted this
          </button>
          <button type="button" className="flex-1" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <section aria-labelledby="seals-heading" className="card">
      <h2 id="seals-heading" className="card-title">
        Seal inbox
      </h2>
      {session ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="actions">
            <button type="button" onClick={() => run('Refresh', refresh)}>
              Refresh
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
          </div>
          <ul aria-label="Seals" className="flex flex-col gap-3">
            {seals.map((seal) => (
              <li key={seal.id} className="item">
                <p className="muted">Quest: {titles[seal.questId] ?? shortenId(seal.questId)}</p>
                <p className="mt-2 whitespace-pre-wrap">{seal.text}</p>
                <Evidence evidence={seal.evidence} />
                <p className="break-all text-xs">Hash: {seal.actionHash}</p>
                <p>
                  <Badge tone={sealTone(sealStatusLabel(seal.status))}>
                    {sealStatusLabel(seal.status)}
                  </Badge>
                </p>
                {seal.status === 'requested' ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <button
                      type="button"
                      className="btn-primary"
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
                    <label htmlFor={`note-${seal.id}`}>Note (if denying)</label>
                    <input
                      id={`note-${seal.id}`}
                      value={notes[seal.id] ?? ''}
                      onChange={(event) => setNotes({ ...notes, [seal.id]: event.target.value })}
                    />
                    <button
                      type="button"
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
                      Deny with note
                    </button>
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
                      {markPostedButton(seal)}
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
                    {markPostedButton(seal)}
                  </div>
                ) : null}
                {confirming === seal.id ? confirmPosted(seal) : null}
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
