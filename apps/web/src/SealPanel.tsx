import { useCallback, useEffect, useState } from 'react'
import { Badge, sealTone } from './Badge'
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
import { DialogueBox, EmptyState, PixelButton, YesNo } from './ui/pixel'
import { WorkSection } from './WorkSection'

function Evidence({ evidence }: { evidence: string }) {
  const { lead, items } = parseEvidence(evidence)
  return (
    <div>
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
  const [asking, setAsking] = useState<{ id: string; verdict: 'approved' | 'denied' } | null>(null)
  const [loaded, setLoaded] = useState(false)
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
      setLoaded(true)
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
    setSeals((all) =>
      all.map((s) =>
        s.id === updated.id ? { ...updated, questTitle: updated.questTitle ?? s.questTitle } : s
      )
    )
  }

  function markPostedButton(seal: InboxSeal) {
    return <PixelButton onClick={() => setConfirming(seal.id)}>Mark posted</PixelButton>
  }

  function confirmPosted(seal: InboxSeal) {
    return (
      <div className="work-body">
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
        <div className="work-actions">
          <PixelButton
            onClick={() =>
              run('Mark posted', async (current) => {
                replace(await markPosted(current, seal, fetch, webAuthnBrowser))
                setConfirming(null)
                setPostUrl('')
              })
            }
          >
            Confirm: I posted this
          </PixelButton>
          <PixelButton onClick={() => setConfirming(null)}>Cancel</PixelButton>
        </div>
      </div>
    )
  }

  function decide(seal: InboxSeal, verdict: 'approved' | 'denied') {
    return run(verdict === 'approved' ? 'Stamp' : 'Deny', async (current) => {
      // A denial settles at once and is put back if the server refuses it.
      if (verdict === 'denied') {
        replace({ ...seal, status: 'denied' })
      }
      try {
        replace(
          await decideSeal(
            current,
            seal,
            verdict,
            verdict === 'denied' ? notes[seal.id]?.trim() || undefined : undefined,
            fetch,
            webAuthnBrowser
          )
        )
      } catch (error) {
        replace(seal)
        throw error
      }
    })
  }

  function questName(seal: InboxSeal) {
    return seal.questTitle ?? titles[seal.questId] ?? 'Untitled Quest'
  }

  return (
    <WorkSection id="seals" title="Seal inbox">
      {session ? (
        <div className="work-body">
          <div className="work-actions">
            <PixelButton onClick={() => run('Refresh', refresh)}>Refresh</PixelButton>
            <PixelButton
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
            </PixelButton>
          </div>
          {loaded && seals.length === 0 && (
            <EmptyState
              member="Herald"
              line="No Seal is waiting. The desk is clear."
              actionLabel="Look again"
              onAction={() => run('Refresh', refresh)}
            />
          )}
          <ul aria-label="Seals">
            {seals.map((seal) => (
              <li key={seal.id} className="work-note">
                <DialogueBox
                  speaker={`Seal for ${questName(seal)}`}
                  lines={seal.text.split(/\n{2,}/)}
                  cps={400}
                  onDone={() => undefined}
                />
                <p className="muted">Quest: {questName(seal)}</p>
                <Evidence evidence={seal.evidence} />
                <p className="break-all work-log">Hash: {seal.actionHash}</p>
                <p>
                  <Badge tone={sealTone(sealStatusLabel(seal.status))}>
                    {sealStatusLabel(seal.status)}
                  </Badge>
                </p>
                {seal.status === 'requested' ? (
                  <div className="work-body">
                    <PixelButton onClick={() => setAsking({ id: seal.id, verdict: 'approved' })}>
                      Stamp with passkey
                    </PixelButton>
                    <label htmlFor={`note-${seal.id}`}>Note (if denying)</label>
                    <input
                      id={`note-${seal.id}`}
                      value={notes[seal.id] ?? ''}
                      onChange={(event) => setNotes({ ...notes, [seal.id]: event.target.value })}
                    />
                    <PixelButton onClick={() => setAsking({ id: seal.id, verdict: 'denied' })}>
                      Deny with note
                    </PixelButton>
                    {asking?.id === seal.id ? (
                      <div className="work-prompt">
                        <YesNo
                          safe="no"
                          question={
                            asking.verdict === 'approved'
                              ? `Stamp this Seal for ${questName(seal)}? Your passkey lets this exact text go out.`
                              : `Refuse this Seal for ${questName(seal)}? Nothing is posted.`
                          }
                          onAnswer={(yes) => {
                            const verdict = asking.verdict
                            setAsking(null)
                            if (yes) {
                              decide(seal, verdict)
                            }
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {seal.stale ? (
                  <div className="work-body">
                    <p>A publish started and never finished. Release only if nothing was posted.</p>
                    <div className="work-actions">
                      <PixelButton
                        onClick={() =>
                          run('Release stale', async (current) =>
                            replace(await releaseStale(current, seal, fetch, webAuthnBrowser))
                          )
                        }
                      >
                        Release (nothing posted)
                      </PixelButton>
                      {markPostedButton(seal)}
                    </div>
                  </div>
                ) : null}
                {seal.status === 'approved' ? (
                  <div className="work-actions">
                    <PixelButton
                      onClick={() => run('Copy', () => navigator.clipboard.writeText(seal.text))}
                    >
                      Copy text
                    </PixelButton>
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
        <p>Sign in with a passkey to use the Seal inbox.</p>
      )}
    </WorkSection>
  )
}
