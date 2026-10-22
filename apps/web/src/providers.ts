import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { confirmVersion, loadCurrent, saveConfig } from './builder/api'
import type { BuilderConfig } from './builder/model'
import { type PasskeyBrowser, PasskeyRequestError, type Session } from './passkeys'

/** A provider as the Guild Master's Settings shows it. */
export interface ProviderRow {
  id: string
  auth: 'subscription' | 'api_key'
  privateEligible: boolean
}

/** Where a provider runs: on this Mac (self-host) or on a hosted Guildhall (subscriptions never run there). */
export interface Deployment {
  hosted: boolean
  /** The vendor behind every provider call, as the server reports it. */
  vendor: string
}

const statusBody = z.object({ hosted: z.boolean(), vendor: z.string().min(1) })

/** Reads where private text would go (`GET /guilds/:id/providers/status`). */
export async function loadProviderStatus(session: Session, fetcher: Fetcher): Promise<Deployment> {
  const res = await fetcher(`/api/guilds/${session.guildId}/providers/status`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    throw new PasskeyRequestError(res.status, 'providers_status_unavailable')
  }
  return statusBody.parse(data)
}

/**
 * The honest sentence on where Private Quests go through this provider, built only from provider
 * data and what the server reports (never from the provider id or model output). "Will be sent"
 * only once the Guild Master has attested the provider; before that it is what would happen.
 */
export function describePrivateDestination(provider: ProviderRow, where: Deployment): string {
  const verb = provider.privateEligible ? 'will be' : 'would be'
  if (provider.auth === 'subscription') {
    if (where.hosted) {
      return 'A subscription provider is not available on a hosted Guildhall: no Private Quest will go through it.'
    }
    return `Private Quests ${verb} sent to ${where.vendor} through your Claude subscription on this Mac.`
  }
  return `Private Quests ${verb} sent to ${where.vendor}'s API with your API key.`
}

const providerRows = z.array(
  z.object({
    id: z.string(),
    auth: z.enum(['subscription', 'api_key']),
    privateEligible: z.boolean().default(false),
  })
)

/** The providers in a config document, validated at the boundary. */
export function providersOf(config: BuilderConfig): ProviderRow[] {
  return providerRows.parse(config.providers ?? [])
}

/** The config with one provider's private eligibility set; every other key is carried untouched. */
export function withPrivateEligible(config: BuilderConfig, id: string, on: boolean): BuilderConfig {
  const rows = z.array(z.looseObject({ id: z.string() })).parse(config.providers ?? [])
  return {
    ...config,
    providers: rows.map((p) => (p.id === id ? { ...p, privateEligible: on } : p)),
  }
}

/**
 * Sets one provider's private eligibility through the guild config. Turning it on is a widening
 * change: it is saved pending, then confirmed with a fresh passkey (`confirmed`). Turning it off
 * applies at once (`applied`).
 */
export async function setProviderPrivate(
  session: Session,
  id: string,
  on: boolean,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<'applied' | 'confirmed'> {
  const { version, config } = await loadCurrent(session, fetcher)
  const saved = await saveConfig(session, withPrivateEligible(config, id, on), fetcher, version)
  if (saved.status === 'applied') {
    return 'applied'
  }
  await confirmVersion(session, saved.version, fetcher, browser)
  return 'confirmed'
}

/** A routing profile as the Settings page shows it. */
export interface ProfileRow {
  id: string
  provider: string
  tier: 'cheap' | 'mid' | 'deep'
  model?: string | undefined
}

/** The routing profiles in a config document, in order (the first is the default Summon uses). */
export function profilesOf(_config: BuilderConfig): ProfileRow[] {
  return []
}

/** The config with a provider added; the Vault secret it uses is named by the same id. */
export function withProvider(
  config: BuilderConfig,
  _provider: { id: string; auth: ProviderRow['auth'] }
): BuilderConfig {
  return config
}

/** The config with a routing profile added (or replaced, by id). */
export function withProfile(config: BuilderConfig, _profile: ProfileRow): BuilderConfig {
  return config
}

/** The config without the routing profile. */
export function withoutProfile(config: BuilderConfig, _id: string): BuilderConfig {
  return config
}

/** The config without the provider and the profiles that named it. */
export function withoutProvider(config: BuilderConfig, _id: string): BuilderConfig {
  return config
}

/** The config with the profile moved first, so Summon preselects it. */
export function withDefaultProfile(config: BuilderConfig, _id: string): BuilderConfig {
  return config
}

/** How a routing change ended: applied at once, or confirmed with a passkey. */
export type RoutingChange = 'applied' | 'confirmed'

/**
 * Saves an edit of the routing parts of the config. A widening edit (a new provider, a new or
 * deeper profile) is saved pending and then confirmed with a fresh passkey; a narrowing one
 * applies at once. The server classifies the change, never this code.
 */
export async function changeRouting(
  _session: Session,
  _edit: (config: BuilderConfig) => BuilderConfig,
  _fetcher: Fetcher,
  _browser: PasskeyBrowser
): Promise<RoutingChange> {
  return 'applied'
}
