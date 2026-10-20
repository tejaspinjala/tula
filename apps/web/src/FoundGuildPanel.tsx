import { type FormEvent, useId, useState } from 'react'
import type { Fetcher } from './artifacts'
import {
  foundGuild,
  type PasskeyBrowser,
  PasskeyRequestError,
  registerPasskey,
  type Session,
  signIn,
} from './passkeys'

/** The words shown for a refused or abandoned founding step. */
function describe(error: unknown, registering: boolean): string {
  if (error instanceof PasskeyRequestError) {
    if (error.status === 429) {
      return 'Too many attempts. Wait a minute, then try again.'
    }
    return registering
      ? 'This founding token has already been used or is no longer valid.'
      : `The guild could not be founded (${error.code}).`
  }
  if (error instanceof Error && error.name === 'NotAllowedError') {
    return 'Passkey creation was cancelled. Try again to finish founding your guild.'
  }
  return 'Founding your guild failed. Try again.'
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
  onSession: (session: Session | null) => void
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
    <section aria-labelledby="found-heading" className="card">
      <h2 id="found-heading" className="card-title">
        Found your guild
      </h2>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-2">
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
        <button type="submit" className="btn-primary" disabled={busy}>
          {founded ? 'Create passkey' : 'Found your guild'}
        </button>
        <p role="alert">{error}</p>
      </form>
    </section>
  )
}
