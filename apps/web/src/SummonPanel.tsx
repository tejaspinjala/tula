import { useCallback, useEffect, useState } from 'react'
import { PasskeyRequestError, type Session } from './passkeys'
import { describeSummon, loadSummon, type SummonStatus, startSummon } from './summon'

const STEP_LABELS = {
  provider: 'A provider with an API key is chosen',
  test_quest: 'The test Quest passed on the worker',
} as const

/**
 * Summon your first member: the Guild Master picks a routing profile and a test Quest runs on the
 * sandboxed worker. The check stays incomplete until that Quest passes.
 */
export function SummonPanel({ session }: { session: Session | null }) {
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
    <section aria-labelledby="summon-heading" className="mt-8">
      <h2 id="summon-heading" className="text-xl font-semibold">
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
            <input
              className="min-h-11 rounded border p-2"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            />
          </label>
          <button type="submit" className="min-h-11 rounded border p-2">
            Summon with this profile
          </button>
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
