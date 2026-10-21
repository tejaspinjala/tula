import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { confirmVersion, loadCurrent, saveConfig } from './builder/api'
import type { BuilderConfig } from './builder/model'
import type { PasskeyBrowser, Session } from './passkeys'

/** A provider as the Guild Master's Settings shows it. */
export interface ProviderRow {
  id: string
  auth: 'subscription' | 'api_key'
  privateEligible: boolean
}

/** Where a provider runs: on this Mac (self-host) or on a hosted Guildhall (subscriptions never run there). */
export interface Deployment {
  hosted: boolean
}

/**
 * The honest sentence on where Private Quests go through this provider, built only from provider
 * data and the deployment (never from model output).
 */
export function describePrivateDestination(provider: ProviderRow, where: Deployment): string {
  if (provider.auth === 'subscription') {
    if (where.hosted) {
      return 'A subscription provider is not available on a hosted Guildhall: no Private Quest will go through it.'
    }
    return `Private Quests will be sent to ${vendorOf(provider.id)} through your Claude subscription on this Mac.`
  }
  return `Private Quests will be sent to ${vendorOf(provider.id)}'s API with your API key.`
}

/** Vendors the Guildhall knows by provider id; any other id is shown as written. */
const VENDORS: Readonly<Record<string, string>> = { anthropic: 'Anthropic' }

function vendorOf(id: string): string {
  return VENDORS[id] ?? id
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
  const { config } = await loadCurrent(session, fetcher)
  const saved = await saveConfig(session, withPrivateEligible(config, id, on), fetcher)
  if (saved.status === 'applied') {
    return 'applied'
  }
  await confirmVersion(session, saved.version, fetcher, browser)
  return 'confirmed'
}
