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
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

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
  onSetupRouting,
}: {
  /** Opens Settings, where providers and routing profiles are added. */
  onSetupRouting?: (() => void) | undefined
  session: Session | null
  /** How often the status is re-read while the test Quest runs. */
  pollMs?: number
}) {
  const [status, setStatus] = useState<SummonStatus | null>(null)
  const [profiles, setProfiles] = useState<RoutingProfileChoice[]>([])
  const [profilesLoaded, setProfilesLoaded] = useState(false)
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
      .then((loaded) => {
        if (live) {
          setProfiles(loaded)
          setProfilesLoaded(true)
          // The first profile is the default; keep a choice the Guild Master already made.
          setProfileId((chosen) => chosen || loaded[0]?.id || '')
        }
      })
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

  const noProfiles = session !== null && profilesLoaded && profiles.length === 0
  const form = session && !noProfiles && (
    <form
      className="work-actions"
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
      <PixelButton type="submit" disabled={profileId === ''}>
        Summon with this profile
      </PixelButton>
    </form>
  )

  return (
    <WorkSection id="summon" title="Summon your first member">
      {!session && <p>Sign in with a passkey to summon a member.</p>}
      {status && (
        <>
          <p role="status">{describeSummon(status)}</p>
          <ul className="work-log">
            {status.steps.map((step) => (
              <li key={step.id}>
                {STEP_LABELS[step.id]}: {step.done ? 'done' : 'not yet'}
              </li>
            ))}
          </ul>
        </>
      )}
      {noProfiles && (
        <>
          <p role="status">
            You have no routing profile yet. Add a provider and a routing profile in Settings, then
            summon.
          </p>
          {onSetupRouting && <PixelButton onClick={onSetupRouting}>▶ Set up routing</PixelButton>}
        </>
      )}
      {status?.complete ? (
        <details>
          <summary>Summon with another profile</summary>
          {form}
        </details>
      ) : (
        form
      )}
      {message && <p role="status">{message}</p>}
    </WorkSection>
  )
}
