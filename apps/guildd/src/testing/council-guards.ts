import { defaultConfig } from '../guild-config'
import type { ConfigStore } from '../ports/config-store'
import type { PresenceStore } from '../ports/presence-store'

/**
 * Stand-ins for the Seal Policy and presence a {@link CouncilEngine} re-reads before approving: by
 * default the policy is `routine_alone` and the Guild Master is away; a test flips `state` mid-run.
 */
export function councilGuards() {
  const state = { away: true, policy: 'routine_alone' as 'routine_alone' | 'always' }
  const config: Pick<ConfigStore, 'current'> = {
    current: async () => ({
      version: 1,
      config: { ...defaultConfig(), sealPolicy: state.policy },
    }),
  }
  const presence: Pick<PresenceStore, 'get'> = {
    get: async () => ({
      away: state.away,
      since: state.away ? '2030-01-01T00:00:00.000Z' : null,
      until: null,
    }),
  }
  return { state, config, presence }
}
