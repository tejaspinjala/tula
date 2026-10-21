import type { GuildConfig } from './guild-config'

/** Which classifier the guild's config binds: the model on a private-eligible provider, or the stand-in. */
export type ClassifierBinding =
  | { kind: 'standin' }
  | { kind: 'model'; providerId: string; profileId: string }

/**
 * Pure binding choice (ADR-0006, ADR-0012): the model classifier runs on the `cheap` tier of a
 * private-eligible provider, else the memory stand-in (which always says private). Deterministic
 * code over config; the caller re-reads config on every call, so turning the flag off unbinds at once.
 */
export function bindClassifier(
  config: Pick<GuildConfig, 'providers' | 'routingProfiles'>
): ClassifierBinding {
  // The first `cheap` profile, the same one the gateway and ModelClassifier resolve.
  const profile = config.routingProfiles.find((r) => r.tier === 'cheap')
  const provider = profile && config.providers.find((p) => p.id === profile.provider)
  if (profile && provider?.privateEligible) {
    return { kind: 'model', providerId: provider.id, profileId: profile.id }
  }
  return { kind: 'standin' }
}
