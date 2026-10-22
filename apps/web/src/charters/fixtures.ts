import type { Charter } from './schema'

/** A small valid Charter for tests. */
export const sampleCharter: Charter = {
  charter: 1,
  name: 'Heralds Guild',
  exportedAt: '2026-10-21T00:00:00.000Z',
  config: {
    steward: { id: 'steward', name: 'Steward' },
    halls: [
      {
        id: 'heralds',
        name: 'Heralds Hall',
        kind: 'work',
        locked: false,
        privateEligible: false,
        captain: { id: 'heralds-captain', name: 'Captain' },
        members: [],
      },
      {
        id: 'forge',
        name: 'Forge',
        kind: 'work',
        locked: false,
        privateEligible: false,
        captain: null,
        members: [],
      },
    ],
    sealPolicy: 'strict',
    caps: { dailyTokens: 9, maxSpawnDepth: 2 },
  },
  rites: [
    {
      name: 'Morning digest',
      graph: { nodes: [{ id: 'start', type: 'trigger.manual' }], edges: [] },
    },
  ],
  omitted: [
    { kind: 'rite', id: 'secret', reason: 'touches a private Hall' },
    { kind: 'rite', id: 'draft', reason: 'unpublished' },
  ],
}
