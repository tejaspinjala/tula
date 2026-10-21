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
  const bound = cheapPrivateProfile(config)
  return bound
    ? { kind: 'model', providerId: bound.provider.id, profileId: bound.profile.id }
    : { kind: 'standin' }
}

/**
 * The one rule for which profile serves the classifier: the first `cheap` profile whose provider
 * is private-eligible, or null. The binding, the model classifier and the gateway all use it.
 */
export function cheapPrivateProfile(config: Pick<GuildConfig, 'providers' | 'routingProfiles'>): {
  profile: GuildConfig['routingProfiles'][number]
  provider: GuildConfig['providers'][number]
} | null {
  for (const profile of config.routingProfiles) {
    if (profile.tier !== 'cheap') {
      continue
    }
    const provider = config.providers.find((p) => p.id === profile.provider)
    if (provider?.privateEligible) {
      return { profile, provider }
    }
  }
  return null
}
