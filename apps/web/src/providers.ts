import type { BuilderConfig } from './builder/model'

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
export function describePrivateDestination(_provider: ProviderRow, _where: Deployment): string {
  return ''
}

/** The providers in a config document, validated at the boundary. */
export function providersOf(_config: BuilderConfig): ProviderRow[] {
  return []
}

/** The config with one provider's private eligibility set; every other key is carried untouched. */
export function withPrivateEligible(
  config: BuilderConfig,
  _id: string,
  _on: boolean
): BuilderConfig {
  return config
}
