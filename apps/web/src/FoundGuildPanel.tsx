import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import type { Fetcher } from './artifacts'
import {
  foundGuildWithPasskey,
  type PasskeyBrowser,
  passkeyFailure,
  passkeyLine,
  type Session,
  signIn,
} from './passkeys'
import { PixelButton } from './ui/pixel'

/**
 * First-run screen: the Guild Master names the guild and its goal, then creates the first
 * passkey. Nothing is written until the passkey verifies, so a cancelled prompt leaves no guild and
 * can simply be retried.
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
  const nameField = useRef<HTMLInputElement>(null)
  // The form replaces the title menu, so keyboard focus moves to its first field.
  useEffect(() => nameField.current?.focus(), [])
  const goalId = useId()
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const guild = await foundGuildWithPasskey(name.trim(), goal.trim(), fetcher, browser)
      onSession(await signIn(guild.id, fetcher, browser))
    } catch (caught) {
      setError(passkeyLine(passkeyFailure(caught), 'founding'))
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
          ref={nameField}
          id={nameId}
          name="guild-name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor={goalId}>Guild goal</label>
        <input
          id={goalId}
          name="guild-goal"
          required
          maxLength={2000}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
        />
        <PixelButton type="submit" disabled={busy}>
          Found your guild
        </PixelButton>
        <p role="alert" className="title-line">
          {error}
        </p>
      </form>
    </section>
  )
}
