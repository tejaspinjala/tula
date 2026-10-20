import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryHandoffStore } from './adapters/memory-handoff-store'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryModelLedger } from './adapters/memory-model-ledger'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { MemoryNoteStore } from './adapters/memory-note-store'
import { MemoryObjectStore } from './adapters/memory-object-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemorySecretStore } from './adapters/memory-secret-store'
import { MemoryToolsetStore } from './adapters/memory-toolset-store'
import { MemoryTripwireStore } from './adapters/memory-tripwire-store'
import { gatewayGuardsContract } from './gateway-guards.contract'
import { defaultConfig, guildConfig } from './guild-config'
import { McpGateway } from './mcp/gateway'
import { ModelGateway } from './model-gateway'

const KEY = 'sk-memory-key'

gatewayGuardsContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const keys = new MemoryKeyProvider()
  const config = new MemoryConfigStore(clock)
  const secrets = new MemorySecretStore(keys)
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const tripwires = new MemoryTripwireStore(clock)
  const provider = new MemoryModelProvider()
  const ledger = new MemoryModelLedger()
  const gatewayDeps = {
    ledger,
    secrets,
    config,
    provider,
    clock,
    quests,
    tripwires,
  }
  const gateway = new ModelGateway(gatewayDeps)
  const mcpDeps = {
    quests,
    config,
    notes: new MemoryNoteStore(),
    objectStore: new MemoryObjectStore(),
    handoffs: new MemoryHandoffStore(),
    toolsets: new MemoryToolsetStore(),
    keys,
    clock,
    tripwires,
  }
  const mcp = new McpGateway(mcpDeps)
  return {
    gateway,
    mcp,
    tripwires,
    quests,
    config,
    ledger,
    provider,
    clock,
    newGuild: async () => {
      const g = crypto.randomUUID()
      await config.seed(g)
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
      const proposed = await config.propose(g, next)
      if (proposed.status === 'pending') {
        await config.confirm(g, proposed.version)
      }
      await secrets.add(g, 'cloud', KEY)
      return g
    },
  }
})
