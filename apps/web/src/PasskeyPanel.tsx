import { useState } from 'react'
import { GuildId } from './GuildId'
import {
  passkeyFailure,
  passkeyLine,
  reauthenticate,
  registerPasskey,
  type Session,
  signIn,
  webAuthnBrowser,
} from './passkeys'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/** Passkey registration, sign-in and re-authentication for one guild; every control is a real button or input. */
export function PasskeyPanel({
  session,
  onSession,
}: {
  session: Session | null
  onSession: (session: Session | null) => void
}) {
  const [guildId, setGuildId] = useState('')
  const [message, setMessage] = useState('')

  async function run(label: string, action: () => Promise<string | undefined>) {
    setMessage(`${label}...`)
    try {
      setMessage((await action()) ?? `${label}: done`)
    } catch (error) {
      setMessage(passkeyLine(passkeyFailure(error), 'sign-in'))
    }
  }

  const guild = guildId.trim()
  return (
    <WorkSection id="passkey" title="Passkey">
      <div className="work-body">
        <label htmlFor="passkey-guild">Guild id</label>
        <input
          id="passkey-guild"
          className="mono"
          value={guildId}
          onChange={(event) => setGuildId(event.target.value)}
        />
        <div className="work-actions">
          <PixelButton
            disabled={!guild}
            onClick={() =>
              run('Register passkey', async () => {
                if (session) {
                  const proof = await reauthenticate(session.token, fetch, webAuthnBrowser)
                  await registerPasskey(
                    guild,
                    { token: session.token, proof },
                    fetch,
                    webAuthnBrowser
                  )
                } else {
                  await registerPasskey(guild, undefined, fetch, webAuthnBrowser)
                }
                return undefined
              })
            }
          >
            Register passkey
          </PixelButton>
          <PixelButton
            disabled={!guild}
            onClick={() =>
              run('Sign in', async () => {
                onSession(await signIn(guild, fetch, webAuthnBrowser))
                return 'Signed in'
              })
            }
          >
            Sign in
          </PixelButton>
        </div>
        {session && (
          <p>
            Signed in to guild <GuildId id={session.guildId} />
          </p>
        )}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </div>
    </WorkSection>
  )
}
