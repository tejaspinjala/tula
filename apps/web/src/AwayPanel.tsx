import { useEffect, useState } from 'react'
import { PasskeyRequestError, type Session } from './passkeys'
import { describeAway, goAway, loadPresence, type Presence, returnHome } from './presence'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/**
 * Away mode in the Bag: step away (optionally until a time) or return in one tap. It needs the
 * signed-in session but no Seal; Bar the Gates is unaffected while away.
 */
export function AwayPanel({ session }: { session: Session }) {
  const [presence, setPresence] = useState<Presence | null>(null)
  const [until, setUntil] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let live = true
    loadPresence(session, fetch)
      .then((next) => live && setPresence(next))
      .catch(() => live && setMessage('Your presence could not be loaded.'))
    return () => {
      live = false
    }
  }, [session])

  async function run(action: () => Promise<Presence>) {
    try {
      setPresence(await action())
      setMessage('')
    } catch (e) {
      setMessage(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The request failed.')
    }
  }

  const stepAway = () => {
    const when = until === '' ? null : new Date(until)
    if (when !== null && Number.isNaN(when.getTime())) {
      setMessage('Pick a valid return time, or leave it empty.')
      return
    }
    return run(() => goAway(session, fetch, when ? when.toISOString() : null))
  }

  return (
    <WorkSection id="away" title="Away mode">
      <p role="status">{presence ? describeAway(presence) : 'Loading.'}</p>
      <label className="flex flex-col">
        Back at (optional)
        <input
          type="datetime-local"
          name="away-until"
          value={until}
          onChange={(event) => setUntil(event.target.value)}
        />
      </label>
      <div className="work-actions">
        <PixelButton onClick={stepAway}>
          {presence?.away ? 'Change return time' : 'Go away'}
        </PixelButton>
        {presence?.away && (
          <PixelButton onClick={() => run(() => returnHome(session, fetch))}>I'm back</PixelButton>
        )}
      </div>
      {message && <p role="alert">{message}</p>}
    </WorkSection>
  )
}
