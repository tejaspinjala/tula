import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { MemoryClock } from './adapters/memory-clock'
import type { MemoryModelProvider } from './adapters/memory-model-provider'
import type { McpGateway } from './mcp/gateway'
import { GatewayError, type ModelGateway } from './model-gateway'
import type { ConfigStore } from './ports/config-store'
import type { Quest, QuestQueue } from './ports/quest-queue'
import type { TripwireStore } from './ports/tripwire-store'
import { callTool } from './testing/scripted-member'
import { runTripwires } from './tripwires'

/** The wired gateways under test; a database-backed fixture founds real guilds. */
export interface GatewayGuardsFixture {
  gateway: ModelGateway
  mcp: McpGateway
  tripwires: TripwireStore
  quests: QuestQueue
  config: ConfigStore
  provider: MemoryModelProvider
  clock: MemoryClock
  /** A fresh guild with an api_key provider, a priced profile `cloud-mid` and a vault key. */
  newGuild: () => Promise<string>
}

const message = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 50 }
const lease = z.object({ questId: z.string(), attempt: z.number(), token: z.string() })
const OK = { ok: true, text: 'x', usage: { inputTokens: 1, outputTokens: 1 } } as const
const TRIP = {
  tokensToday: 0,
  tokensPerDay7d: [],
  gateDenialsLastHour: 1_000,
  maxActionRepeats: 0,
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof GatewayError) {
      return e.code
    }
    throw e
  }
  return 'no error'
}

/** The gateway guard scenarios (Hall pause, Quest attempt binding), run against every adapter set. */
export function gatewayGuardsContract(name: string, make: () => Promise<GatewayGuardsFixture>) {
  describe(`Gateway guards: ${name}`, () => {
    async function openRun(f: GatewayGuardsFixture, g: string, runId: string) {
      return f.gateway.openRun(g, {
        runId,
        questId: 'quest-1',
        hallId: 'heralds',
        profileId: 'cloud-mid',
      })
    }
    async function started(f: GatewayGuardsFixture, g: string, runId: string): Promise<string> {
      const out = await openRun(f, g, runId)
      if (out.status !== 'started') {
        throw new Error(`expected started, got ${out.status}`)
      }
      return out.token
    }
    const pause = (f: GatewayGuardsFixture, g: string, hallId = 'heralds') =>
      f.tripwires.pause(g, { hallId, tripwire: 'manual', observed: 0, threshold: 0 })
    const post = async (f: GatewayGuardsFixture, g: string): Promise<Quest> =>
      (
        await f.quests.post(g, {
          jobKey: crypto.randomUUID(),
          templateId: 'herald-brief',
          hallId: 'heralds',
          rank: 'journeyman',
          dataClass: 'internal',
          title: 'Draft the brief',
          ownerId: 'heralds-member-2',
          doneCondition: 'A draft brief is filed in the Archive',
          roundLimit: 2,
        })
      ).quest
    const claim = async (f: GatewayGuardsFixture, g: string, quest: Quest) =>
      callTool((r) => f.mcp.handle(r), 'claim_quest', {
        assignment: await f.mcp.assign(g, quest),
      })

    test('a paused Hall gets no run token, and resuming restores it', async () => {
      const f = await make()
      const g = await f.newGuild()
      await pause(f, g)
      const refused: unknown = await openRun(f, g, 'r1')
      expect(refused).toEqual({ status: 'refused', reason: 'hall_paused' })
      await f.tripwires.resume(g, 'heralds')
      expect((await openRun(f, g, 'r1')).status).toBe('started')
    })

    test('a run active when the Hall is paused is refused before reserve and before the provider', async () => {
      const f = await make()
      const g = await f.newGuild()
      f.provider.script(OK)
      const token = await started(f, g, 'r1')
      const before = f.provider.seen.length
      await pause(f, g)
      expect(await codeOf(f.gateway.complete(token, message))).toBe('hall_paused')
      expect(f.provider.seen.length).toBe(before)
      expect((await f.gateway.usage(g, 'run', { limit: 10 })).rows).toEqual([])
      await f.tripwires.resume(g, 'heralds')
      expect(await codeOf(f.gateway.complete(token, message))).toBe('no error')
    })

    test('a paused Hall leases none of its queued Quests; resuming leases them', async () => {
      const f = await make()
      const g = await f.newGuild()
      const quest = await post(f, g)
      await pause(f, g)
      const refused = await claim(f, g, quest)
      expect(refused.isError).toBe(true)
      expect(refused.data.error).toBe('hall_paused')
      await f.tripwires.resume(g, 'heralds')
      const claimed = await claim(f, g, quest)
      expect(claimed.isError).toBe(false)
      expect(lease.parse(claimed.data.lease).attempt).toBe(1)
    })

    test("tripping a Tripwire revokes the Hall's active runs", async () => {
      const f = await make()
      const g = await f.newGuild()
      const token = await started(f, g, 'r1')
      const deps = { config: f.config, tripwires: f.tripwires, runs: f.gateway }
      const out = await runTripwires(deps, g, 'heralds', TRIP)
      expect(out.paused).toBe(true)
      expect(await codeOf(f.gateway.complete(token, message))).toBe('token_revoked')
    })

    test('a pause in guild B leaves guild A unaffected', async () => {
      const f = await make()
      const a = await f.newGuild()
      const b = await f.newGuild()
      f.provider.script(OK)
      const tokenA = await started(f, a, 'r1')
      const tokenB = await started(f, b, 'r1')
      await pause(f, b)
      expect(await codeOf(f.gateway.complete(tokenB, message))).toBe('hall_paused')
      expect(await codeOf(f.gateway.complete(tokenA, message))).toBe('no error')
      expect((await openRun(f, a, 'r2')).status).toBe('started')
      const second: unknown = await openRun(f, b, 'r2')
      expect(second).toEqual({ status: 'refused', reason: 'hall_paused' })
      const quest = await post(f, a)
      expect((await claim(f, a, quest)).isError).toBe(false)
    })
  })
}
