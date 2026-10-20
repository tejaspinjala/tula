import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemorySealStore } from '../adapters/memory-seal-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import { MemoryWorkflowStore } from '../adapters/memory-workflow-store'
import { ProposalEngine } from '../proposals'
import { WorkflowEngine } from './engine'
import { mountWorkflowRoutes } from './routes'
import { LEARNING_TO_LINKEDIN } from './templates'

/** Mounts the routes over an identity stub whose session has the given role and a valid proof. */
async function setup(role: string) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  const engine = new WorkflowEngine({
    store: new MemoryWorkflowStore(clock),
    config,
    quests: new MemoryQuestQueue(clock, () => 0.5),
    tripwires: new MemoryTripwireStore(clock),
    proposals: new ProposalEngine({ store: new MemoryProposalStore(clock), config }),
    seals: new MemorySealStore(clock),
  })
  const principal = { guildId: guild, memberId: 'm', role }
  const identity = {
    resolveSession: async () => principal,
    consumeReauth: async (_token: string, proof: string) => proof === 'good',
  }
  const app = new Hono()
  const guard = async () => ({ guild })
  mountWorkflowRoutes(app, {
    workflows: engine,
    identity,
    sessionGuildFor: guard,
    guildMasterSessionFor: guard,
  })
  return { app, engine, guild }
}

test('confirming a pending version needs the Guild Master and a proof', async () => {
  for (const [role, proof, status] of [
    ['member', 'good', 403],
    ['guild_master', 'bad', 403],
    ['guild_master', 'good', 200],
  ] as const) {
    const { app, engine, guild } = await setup(role)
    await engine.save(guild, 'wf', { name: 'x', graph: LEARNING_TO_LINKEDIN })
    const res = await app.request(`/guilds/${guild}/workflows/wf/versions/1/confirm`, {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'x-reauth-proof': proof },
    })
    expect(res.status).toBe(status)
    expect((await engine.get(guild, 'wf', 1))?.version.status).toBe(
      status === 200 ? 'active' : 'pending'
    )
  }
})
