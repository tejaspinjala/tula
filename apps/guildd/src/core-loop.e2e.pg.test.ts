import { afterAll } from 'bun:test'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { coreLoopEndToEnd, type E2eWorld } from './core-loop.e2e'
import { defaultConfig, guildConfig } from './guild-config'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'
import { RecordingSandboxRunner } from './testing/recording-sandbox'

const provider = new MemoryModelProvider()
const sandboxes = new RecordingSandboxRunner()
const harness = await createHarness({ app: { modelProvider: provider, sandboxes } })
afterAll(async () => {
  await harness.close()
})

/** The composed app over Postgres: the same engines and the same `dispatch()` the server runs. */
async function pgWorld(): Promise<E2eWorld> {
  const a = harness.adapters
  return {
    clock: a.clock,
    quests: a.quests,
    sealStore: a.sealStore,
    seals: a.seals,
    proposals: a.proposals,
    dispatcher: a.dispatcher,
    gateway: a.gateway,
    mcp: a.mcp,
    gates: a.gates,
    ledger: a.modelLedger,
    postCosts: a.postCosts,
    provider,
    sandboxes,
    newGuild: async (options = {}) => {
      const guildId = await harness.foundGuild({ name: 'Loop', goal: 'g' })
      await a.config.seed(guildId)
      const next = guildConfig.parse({
        ...defaultConfig(),
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
      const proposed = await a.config.propose(guildId, next)
      if (proposed.status === 'pending') {
        await a.config.confirm(guildId, proposed.version)
      }
      await a.secrets.add(guildId, 'cloud', 'sk-e2e-test-key')
      const session = await openSession(a.identity, guildId)
      const principal = await a.identity.resolveSession(session)
      if (!principal) {
        throw new Error('the session did not resolve')
      }
      return { guildId, masterId: principal.memberId }
    },
  }
}

coreLoopEndToEnd('postgres', pgWorld)
