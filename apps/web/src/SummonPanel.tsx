import { useCallback, useEffect, useState } from 'react'
import { PasskeyRequestError, type Session } from './passkeys'
import { describeSummon, loadSummon, type SummonStatus, startSummon } from './summon'

/** What each Summon step means, shown beside its tick in the panel. */
export const STEP_LABELS = {
  provider: 'A model provider is chosen: an API key or your Claude subscription',
  test_quest: 'The test Quest passed on the worker',
} as const

/**
 * Summon your first member: the Guild Master picks a routing profile and a test Quest runs on the
 * sandboxed worker. The check stays incomplete until that Quest passes.
 */
export function SummonPanel({
  session,
}: {
  session: Session | null
  /** How often the status is re-read while the test Quest runs. */
  pollMs?: number
}) {
  const [status, setStatus] = useState<SummonStatus | null>(null)
  const [profileId, setProfileId] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(() => {
    if (!session) {
      setStatus(null)
      return
    }
    loadSummon(session, fetch)
      .then(setStatus)
      .catch(() => setMessage('The summon status could not be loaded.'))
  }, [session])

  useEffect(refresh, [refresh])

  async function summon() {
    if (!session || profileId.trim() === '') {
      return
    }
    try {
      setStatus(await startSummon(session, profileId.trim(), fetch))
      setMessage('')
    } catch (e) {
      setMessage(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The request failed.')
    }
  }

  return (
    <section aria-labelledby="summon-heading" className="card">
      <h2 id="summon-heading" className="card-title">
        Summon your first member
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to summon a member.</p>}
      {status && (
        <>
          <p className="mt-4" role="status">
            {describeSummon(status)}
          </p>
          <ul className="mt-2 list-disc pl-6">
            {status.steps.map((step) => (
              <li key={step.id}>
                {STEP_LABELS[step.id]}: {step.done ? 'done' : 'not yet'}
              </li>
            ))}
          </ul>
        </>
      )}
      {session && (
        <form
          className="mt-4 flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            summon()
          }}
        >
          <label className="flex flex-col">
            Routing profile
            <input value={profileId} onChange={(event) => setProfileId(event.target.value)} />
          </label>
          <button type="submit">Summon with this profile</button>
        </form>
      )}
      {message && (
        <p className="mt-4" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
