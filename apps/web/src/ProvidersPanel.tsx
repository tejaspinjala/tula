import { useCallback, useEffect, useState } from 'react'
import { loadCurrent } from './builder/api'
import { type PasskeyBrowser, PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import {
  changeRouting,
  type Deployment,
  describePrivateDestination,
  loadProviderStatus,
  type ProfileRow,
  type ProviderRow,
  profilesOf,
  providersOf,
  setProviderPrivate,
  withDefaultProfile,
  withoutProfile,
  withProfile,
  withProvider,
} from './providers'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/** Narrows a select value to a model tier. */
function tierOf(value: string): ProfileRow['tier'] {
  return value === 'cheap' || value === 'deep' ? value : 'mid'
}

/**
 * Settings > Providers: add a provider (which names the Vault secret it uses; the key itself is
 * never typed here), add, remove and reorder routing profiles (the first is the default Summon
 * uses). A widening change asks for the passkey; removing or narrowing applies at once.
 * Each provider's private-eligible state and where Private Quests would go
 * through it. Turning it on asks for the passkey again (a widening change); turning it off applies
 * at once. The disclosure comes from the server: whether subscriptions run here and which vendor is called.
 */
export function ProvidersPanel({
  session,
  browser = webAuthnBrowser,
}: {
  session: Session
  browser?: PasskeyBrowser
}) {
  const [rows, setRows] = useState<ProviderRow[] | null>(null)
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [providerId, setProviderId] = useState('')
  const [providerKind, setProviderKind] = useState<ProviderRow['auth']>('api_key')
  const [profileId, setProfileId] = useState('')
  const [profileProvider, setProfileProvider] = useState('')
  const [profileTier, setProfileTier] = useState<ProfileRow['tier']>('mid')
  const [profileModel, setProfileModel] = useState('')
  const [where, setWhere] = useState<Deployment | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    Promise.all([loadCurrent(session, fetch), loadProviderStatus(session, fetch)])
      .then(([current, status]) => {
        setRows(providersOf(current.config))
        setProfiles(profilesOf(current.config))
        setWhere(status)
      })
      .catch(() => setMessage('Your providers could not be loaded.'))
  }, [session])

  useEffect(refresh, [refresh])

  async function change(row: ProviderRow, on: boolean) {
    setBusy(true)
    try {
      const done = await setProviderPrivate(session, row.id, on, fetch, browser)
      setMessage(
        done === 'confirmed'
          ? `${row.id} may now serve Private Quests.`
          : `${row.id} no longer serves Private Quests.`
      )
    } catch (e) {
      setMessage(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The change failed.')
    }
    setBusy(false)
    refresh()
  }

  async function route(
    done: string,
    edit: Parameters<typeof changeRouting>[1],
    reset?: () => void
  ) {
    setBusy(true)
    try {
      const how = await changeRouting(session, edit, fetch, browser)
      setMessage(how === 'confirmed' ? `${done} (confirmed with your passkey).` : `${done}.`)
      reset?.()
    } catch (e) {
      setMessage(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The change failed.')
    }
    setBusy(false)
    refresh()
  }

  const target = profileProvider || rows?.[0]?.id || ''

  return (
    <WorkSection id="providers" title="Providers">
      {(rows === null || where === null) && !message && <p role="status">Loading.</p>}
      {rows?.length === 0 && <p>No provider is configured yet.</p>}
      {rows && where && rows.length > 0 && (
        <ul className="provider-list">
          {rows.map((row) => (
            <li key={row.id} className="work-note provider-row">
              <p className="provider-name">
                {row.id}{' '}
                <span className="provider-state">
                  {row.privateEligible ? '✓ Private-eligible' : '○ Not private-eligible'}
                </span>
              </p>
              <p>{describePrivateDestination(row, where)}</p>
              <div className="work-actions">
                <PixelButton
                  disabled={busy}
                  onClick={() => change(row, !row.privateEligible)}
                  aria-label={`${row.privateEligible ? 'Stop private work on' : 'Allow private work on'} ${row.id}`}
                >
                  {row.privateEligible ? 'Turn off' : 'Allow private work'}
                </PixelButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows && (
        <form
          className="work-body"
          onSubmit={(event) => {
            event.preventDefault()
            const id = providerId.trim()
            route(
              `Provider ${id} added`,
              (c) => withProvider(c, { id, auth: providerKind }),
              () => setProviderId('')
            )
          }}
        >
          <label htmlFor="provider-id">Provider name</label>
          <input
            id="provider-id"
            name="provider-id"
            className="mono"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          />
          <label htmlFor="provider-kind">Kind</label>
          <select
            id="provider-kind"
            name="provider-kind"
            value={providerKind}
            onChange={(event) =>
              setProviderKind(event.target.value === 'subscription' ? 'subscription' : 'api_key')
            }
          >
            <option value="api_key">API key</option>
            <option value="subscription">Subscription</option>
          </select>
          <p>
            An API key lives in the Vault under the same name as the provider: add it there. It is
            never typed here.
          </p>
          <div className="work-actions">
            <PixelButton type="submit" disabled={busy || providerId.trim() === ''}>
              Add provider
            </PixelButton>
          </div>
        </form>
      )}
      {rows && rows.length > 0 && (
        <>
          {profiles.length > 0 && (
            <ul className="provider-list" aria-label="Routing profiles">
              {profiles.map((profile, index) => (
                <li key={profile.id} className="work-note provider-row">
                  <p className="provider-name">
                    {profile.id}{' '}
                    <span className="provider-state">
                      {`${profile.tier}, ${profile.provider}`}
                      {index === 0 ? ' - Default' : ''}
                    </span>
                  </p>
                  <div className="work-actions">
                    {index > 0 && (
                      <PixelButton
                        disabled={busy}
                        onClick={() =>
                          route(`${profile.id} is now the default profile`, (c) =>
                            withDefaultProfile(c, profile.id)
                          )
                        }
                        aria-label={`Make ${profile.id} the default profile`}
                      >
                        Make default
                      </PixelButton>
                    )}
                    <PixelButton
                      disabled={busy}
                      onClick={() =>
                        route(`Profile ${profile.id} removed`, (c) => withoutProfile(c, profile.id))
                      }
                      aria-label={`Remove profile ${profile.id}`}
                    >
                      Remove
                    </PixelButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form
            className="work-body"
            onSubmit={(event) => {
              event.preventDefault()
              const id = profileId.trim()
              const model = profileModel.trim()
              route(
                `Profile ${id} added`,
                (c) =>
                  withProfile(c, {
                    id,
                    provider: target,
                    tier: profileTier,
                    ...(model === '' ? {} : { model }),
                  }),
                () => {
                  setProfileId('')
                  setProfileModel('')
                }
              )
            }}
          >
            <label htmlFor="profile-id">Profile name</label>
            <input
              id="profile-id"
              name="profile-id"
              className="mono"
              value={profileId}
              onChange={(event) => setProfileId(event.target.value)}
            />
            <label htmlFor="profile-provider">Provider</label>
            <select
              id="profile-provider"
              name="profile-provider"
              value={target}
              onChange={(event) => setProfileProvider(event.target.value)}
            >
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.id}
                </option>
              ))}
            </select>
            <label htmlFor="profile-tier">Model tier</label>
            <select
              id="profile-tier"
              name="profile-tier"
              value={profileTier}
              onChange={(event) => setProfileTier(tierOf(event.target.value))}
            >
              <option value="cheap">Cheap</option>
              <option value="mid">Mid</option>
              <option value="deep">Deep</option>
            </select>
            <label htmlFor="profile-model">Model (optional)</label>
            <input
              id="profile-model"
              name="profile-model"
              className="mono"
              value={profileModel}
              onChange={(event) => setProfileModel(event.target.value)}
            />
            <div className="work-actions">
              <PixelButton type="submit" disabled={busy || profileId.trim() === ''}>
                Add profile
              </PixelButton>
            </div>
          </form>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </WorkSection>
  )
}
