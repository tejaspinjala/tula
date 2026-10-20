import { useCallback, useEffect, useState } from 'react'
import { PasskeyRequestError, type Session } from './passkeys'
import {
  describeSummon,
  loadRoutingProfiles,
  loadSummon,
  type RoutingProfileChoice,
  type SummonStatus,
  startSummon,
} from './summon'

/** What each Summon step means, shown beside its tick in the panel. */
export const STEP_LABELS = {
  provider: 'A model provider is chosen: an API key or your Claude subscription',
  test_quest: 'The test Quest passed on the worker',
} as const

/**
 * Summon your first member: the Guild Master picks one of the guild's routing profiles and a test
 * Quest runs on the sandboxed worker. The check stays incomplete until that Quest passes, and the
 * panel re-reads the status by itself while the Quest runs.
 */
export function SummonPanel({
  session,
  pollMs = 3000,
}: {
  session: Session | null
  /** How often the status is re-read while the test Quest runs. */
  pollMs?: number
}) {
  const [status, setStatus] = useState<SummonStatus | null>(null)
  const [profiles, setProfiles] = useState<RoutingProfileChoice[]>([])
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

  useEffect(() => {
    if (!session) {
      setProfiles([])
      return
    }
    let live = true
    loadRoutingProfiles(session, fetch)
      .then((loaded) => live && setProfiles(loaded))
      .catch(() => live && setMessage('The routing profiles could not be loaded.'))
    return () => {
      live = false
    }
  }, [session])

  // While the test Quest runs, keep re-reading the status so the panel turns complete by itself.
  const running = status !== null && !status.complete && status.quest !== null
  useEffect(() => {
    if (!running) {
      return
    }
    const timer = setInterval(refresh, pollMs)
    return () => clearInterval(timer)
  }, [running, refresh, pollMs])

  async function summon() {
    if (!session || profileId === '') {
      return
    }
    try {
      setStatus(await startSummon(session, profileId, fetch))
      setMessage('')
    } catch (e) {
      setMessage(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The request failed.')
    }
  }

  const form = session && (
    <form
      className="mt-4 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        summon()
      }}
    >
      <label className="flex flex-col">
        Routing profile
        <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          <option value="">Choose a routing profile</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {`${profile.id} (${profile.tier}, ${profile.provider})`}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={profileId === ''}>
        Summon with this profile
      </button>
    </form>
  )

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
      {status?.complete ? (
        <details className="mt-4">
          <summary>Summon with another profile</summary>
          {form}
        </details>
      ) : (
        form
      )}
      {message && (
        <p className="mt-4" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
