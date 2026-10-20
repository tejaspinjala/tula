import { useState } from 'react'
import { PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import { decideSeal, type InboxSeal, listSeals, markPosted } from './seals'

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

  const refresh = async (current: Session) => setSeals((await listSeals(current, fetch)).seals)

  function replace(updated: InboxSeal) {
    setSeals((all) => all.map((s) => (s.id === updated.id ? updated : s)))
  }

  return (
    <section aria-labelledby="seals-heading" className="mt-8">
      <h2 id="seals-heading" className="text-xl font-semibold">
        Seal inbox
      </h2>
      {session ? (
        <div className="mt-4 flex flex-col gap-3">
          <button
            type="button"
            className="min-h-11 rounded border p-2"
            onClick={() => run('Load Seals', refresh)}
          >
            Load Seals
          </button>
          <ul aria-label="Seals" className="flex flex-col gap-3">
            {seals.map((seal) => (
              <li key={seal.id} className="rounded border p-3">
                <p className="whitespace-pre-wrap">{seal.text}</p>
                <p className="mt-2 text-sm">Evidence: {seal.evidence}</p>
                <p className="break-all text-xs">Hash: {seal.actionHash}</p>
                <p className="text-sm">Status: {seal.status}</p>
                {seal.status === 'requested' ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <label htmlFor={`note-${seal.id}`}>Note (if denying)</label>
                    <input
                      id={`note-${seal.id}`}
                      className="rounded border p-2"
                      value={notes[seal.id] ?? ''}
                      onChange={(event) => setNotes({ ...notes, [seal.id]: event.target.value })}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="min-h-11 flex-1 rounded bg-black p-2 text-white"
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
                        className="min-h-11 flex-1 rounded border p-2"
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
                {seal.status === 'approved' ? (
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="min-h-11 flex-1 rounded border p-2"
                      onClick={() => run('Copy', () => navigator.clipboard.writeText(seal.text))}
                    >
                      Copy text
                    </button>
                    <button
                      type="button"
                      className="min-h-11 flex-1 rounded bg-black p-2 text-white"
                      onClick={() =>
                        run('Mark posted', async (current) =>
                          replace(await markPosted(current, seal, fetch))
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
