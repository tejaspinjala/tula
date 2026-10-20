import { afterAll } from 'bun:test'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { PgModelLedger } from './adapters/pg-model-ledger'
import { gatewayGuardsContract } from './gateway-guards.contract'
import { defaultConfig, guildConfig } from './guild-config'
import { createHarness } from './testing/harness'

const provider = new MemoryModelProvider()
const harness = await createHarness({
  isolatedDb: true,
  devGuildHeader: true,
  app: { modelProvider: provider },
})
afterAll(async () => {
  await harness.close()
})

gatewayGuardsContract('postgres', async () => {
  const { adapters } = harness
  return {
    gateway: adapters.gateway,
    gates: adapters.gates,
    sandboxes: adapters.sandboxes,
    mcp: adapters.mcp,
    tripwires: adapters.tripwires,
    quests: adapters.quests,
    config: adapters.config,
    ledger: new PgModelLedger(adapters.db, new MemoryKeyProvider()),
    provider,
    clock: adapters.clock,
    newGuild: async () => {
      const g = await harness.foundGuild({ name: 'Guards', goal: 'g' })
      await adapters.config.seed(g)
      const next = guildConfig.parse({
        ...defaultConfig(),
        providers: [{ id: 'cloud', auth: 'api_key' }],
        routingProfiles: [
          {
            id: 'cloud-mid',
            provider: 'cloud',
            tier: 'mid',
            model: 'configured-model',
            price: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
          },
        ],
      })
      const proposed = await adapters.config.propose(g, next)
      if (proposed.status === 'pending') {
        await adapters.config.confirm(g, proposed.version)
      }
      await adapters.secrets.add(g, 'cloud', 'sk-pg-key')
      return g
    },
  }
})
