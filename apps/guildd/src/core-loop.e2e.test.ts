import { MemoryAwaitingSealReader } from './adapters/memory-awaiting-seal-reader'
import { MemoryClassifier } from './adapters/memory-classifier'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryGateStore } from './adapters/memory-gate-store'
import { MemoryHandoffStore } from './adapters/memory-handoff-store'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { MemoryMissiveStore } from './adapters/memory-missive-store'
import { MemoryModelLedger } from './adapters/memory-model-ledger'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { MemoryNoteStore } from './adapters/memory-note-store'
import { MemoryObjectStore } from './adapters/memory-object-store'
import { MemoryPostCostReader } from './adapters/memory-post-cost-reader'
import { MemoryProposalStore } from './adapters/memory-proposal-store'
import { MemoryQuestQueue } from './adapters/memory-quest-queue'
import { MemoryRoutingLog } from './adapters/memory-routing-log'
import { MemorySealStore } from './adapters/memory-seal-store'
import { MemorySecretStore } from './adapters/memory-secret-store'
import { MemoryToolsetStore } from './adapters/memory-toolset-store'
import { MemoryTripwireStore } from './adapters/memory-tripwire-store'
import { MemoryWorkflowStore } from './adapters/memory-workflow-store'
import { coreLoopEndToEnd, type E2eWorld, hallsFor } from './core-loop.e2e'
import { Dispatcher } from './dispatch'
import { Gates } from './gates'
import { defaultConfig, guildConfig } from './guild-config'
import { McpGateway } from './mcp/gateway'
import { ModelGateway } from './model-gateway'
import { ProposalEngine } from './proposals'
import { retireRun } from './retire-run'
import { SealEngine } from './seals'
import { RecordingSandboxRunner } from './testing/recording-sandbox'
import { WorkflowEngine } from './workflows/engine'

/** The memory adapters wired by hand, as the gateway and MCP suites wire them. */
async function memoryWorld(): Promise<E2eWorld> {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const keys = new MemoryKeyProvider()
  const config = new MemoryConfigStore(clock)
  const secrets = new MemorySecretStore(keys)
  const gateStore = new MemoryGateStore()
  const quests = new MemoryQuestQueue(
    clock,
    () => 0.5,
    () => {},
    () => false,
    (guildId) => gateStore.barredNow(guildId)
  )
  const sandboxes = new RecordingSandboxRunner()
  const guilds: string[] = []
  const tripwires = new MemoryTripwireStore(clock)
  const provider = new MemoryModelProvider()
  const ledger = new MemoryModelLedger()
  const gateway = new ModelGateway({
    ledger,
    secrets,
    config,
    provider,
    clock,
    quests,
    tripwires,
    gates: gateStore,
  })
  const proposals = new ProposalEngine({ store: new MemoryProposalStore(clock), config })
  const mcp = new McpGateway({
    quests,
    config,
    notes: new MemoryNoteStore(),
    missives: new MemoryMissiveStore(),
    objectStore: new MemoryObjectStore(),
    handoffs: new MemoryHandoffStore(),
    toolsets: new MemoryToolsetStore(),
    proposals,
    keys,
    clock,
    tripwires,
    gates: gateStore,
    retireRun: retireRun({ runs: gateway, sandboxes }),
  })
  const gates = new Gates({
    store: gateStore,
    runs: gateway,
    sandboxes,
    quests,
    guildIds: async (after, limit) =>
      [...guilds]
        .sort()
        .filter((g) => after === undefined || g > after)
        .slice(0, limit),
  })
  const sealStore = new MemorySealStore(clock)
  const seals = new SealEngine({
    store: sealStore,
    config,
    identity: { findMember: async () => null },
  })
  const dispatcher = new Dispatcher({
    config,
    quests,
    sealStore,
    awaiting: new MemoryAwaitingSealReader(quests, sealStore),
    proposals,
    seals,
    routing: { classifier: new MemoryClassifier(), log: new MemoryRoutingLog(), keys },
    ledger,
    tripwires,
    clock,
    random: () => 0.5,
    hosted: false,
    gates: gateStore,
    gateway,
    mcp,
    sandboxes,
  })
  return {
    clock,
    quests,
    sealStore,
    seals,
    proposals,
    workflows: new WorkflowEngine({
      store: new MemoryWorkflowStore(clock),
      config,
      quests,
      tripwires,
      proposals,
      seals: sealStore,
    }),
    dispatcher,
    gateway,
    mcp,
    gates,
    ledger,
    postCosts: new MemoryPostCostReader({ ledger, quests, sealStore }),
    provider,
    sandboxes,
    newGuild: async (options = {}) => {
      const guildId = crypto.randomUUID()
      guilds.push(guildId)
      await config.seed(guildId)
      const next = guildConfig.parse({
        ...defaultConfig(),
        halls: hallsFor(options),
        ...(options.caps ? { caps: options.caps } : {}),
        ...(options.contentPolicy ? { contentPolicy: options.contentPolicy } : {}),
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
      const proposed = await config.propose(guildId, next)
      if (proposed.status === 'pending') {
        await config.confirm(guildId, proposed.version)
      }
      await secrets.add(guildId, 'cloud', 'sk-memory-key')
      return { guildId, masterId: 'the-guild-master' }
    },
  }
}

coreLoopEndToEnd('memory', memoryWorld)
