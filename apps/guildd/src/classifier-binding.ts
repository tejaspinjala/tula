import type { GuildConfig } from './guild-config'

/** Which classifier the guild's config binds: the model on a private-eligible provider, or the stand-in. */
export type ClassifierBinding =
  | { kind: 'standin' }
  | { kind: 'model'; providerId: string; profileId: string }

/** Stub: always the stand-in. */
export function bindClassifier(
  _config: Pick<GuildConfig, 'providers' | 'routingProfiles'>
): ClassifierBinding {
  return { kind: 'standin' }
}
