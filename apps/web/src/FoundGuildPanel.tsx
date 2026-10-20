import { type FormEvent, useId, useState } from 'react'
import type { Fetcher } from './artifacts'
import {
  foundGuild,
  type PasskeyBrowser,
  passkeyFailure,
  passkeyLine,
  registerPasskey,
  type Session,
  signIn,
} from './passkeys'
import { PixelButton } from './ui/pixel'

/** The words shown for a refused or abandoned founding step. */
function describe(error: unknown, registering: boolean): string {
  const kind = passkeyFailure(error)
  if (kind === 'refused' && registering) {
    return 'This founding token has already been used or is no longer valid.'
  }
  return passkeyLine(kind, 'founding')
}

/**
 * First-run screen: the Guild Master names the guild and its goal, then creates the first
 * passkey. The one-time founding token lives only in this component's memory (never storage or
 * the URL), so a cancelled passkey can be retried without founding a second guild.
 */
export function FoundGuildPanel({
  fetcher,
  browser,
  onSession,
}: {
  fetcher: Fetcher
  browser: PasskeyBrowser
  onSession: (session: Session) => void
}) {
  const nameId = useId()
  const goalId = useId()
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [founded, setFounded] = useState<{ id: string; foundingToken: string } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    let registering = founded !== null
    try {
      const guild = founded ?? (await foundGuild(name.trim(), goal.trim(), fetcher))
      setFounded(guild)
      registering = true
      await registerPasskey(guild.id, undefined, fetcher, browser, guild.foundingToken)
      registering = false
      setFounded(null)
      onSession(await signIn(guild.id, fetcher, browser))
    } catch (caught) {
      setError(describe(caught, registering))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="found-heading">
      <h2 id="found-heading" className="title-line">
        Found your guild
      </h2>
      <form onSubmit={submit} className="title-form">
        <label htmlFor={nameId}>Guild name</label>
        <input
          id={nameId}
          name="guild-name"
          required
          maxLength={200}
          disabled={founded !== null}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor={goalId}>Guild goal</label>
        <input
          id={goalId}
          name="guild-goal"
          required
          maxLength={2000}
          disabled={founded !== null}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        <PixelButton type="submit" disabled={busy}>
          {founded ? 'Create passkey' : 'Found your guild'}
        </PixelButton>
        <p role="alert" className="title-line">
          {error}
        </p>
      </form>
    </section>
  )
}
