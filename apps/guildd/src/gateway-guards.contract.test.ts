import { afterAll } from 'bun:test'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { gatewayGuardsContract } from './gateway-guards.contract'
import { defaultConfig, guildConfig } from './guild-config'
import { createHarness } from './testing/harness'

const provider = new MemoryModelProvider()
const harness = await createHarness({ devGuildHeader: true, app: { modelProvider: provider } })
afterAll(async () => {
  await harness.close()
})

gatewayGuardsContract('postgres', async () => {
  const { adapters } = harness
  return {
    gateway: adapters.gateway,
    mcp: adapters.mcp,
    tripwires: adapters.tripwires,
    quests: adapters.quests,
    config: adapters.config,
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
