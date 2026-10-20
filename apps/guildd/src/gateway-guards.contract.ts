import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { MemoryClock } from './adapters/memory-clock'
import type { MemoryModelProvider } from './adapters/memory-model-provider'
import type { Gates } from './gates'
import type { McpGateway } from './mcp/gateway'
import { GatewayError, type ModelGateway } from './model-gateway'
import type { ConfigStore } from './ports/config-store'
import type { ModelLedger } from './ports/model-ledger'
import type { Quest, QuestQueue } from './ports/quest-queue'
import type { SandboxRunner } from './ports/sandbox-runner'
import type { TripwireStore } from './ports/tripwire-store'
import { callTool } from './testing/scripted-member'
import { runTripwires } from './tripwires'

/** The wired gateways under test; a database-backed fixture founds real guilds. */
export interface GatewayGuardsFixture {
  gateway: ModelGateway
  mcp: McpGateway
  /** Bar the Gates over the same gateways, queue and sandboxes. */
  gates: Gates
  sandboxes: SandboxRunner
  tripwires: TripwireStore
  quests: QuestQueue
  config: ConfigStore
  ledger: ModelLedger
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
    /** Posts and claims a Quest (attempt 1), so a run can be opened for it. */
    async function leased(f: GatewayGuardsFixture, g: string): Promise<Quest> {
      const quest = await post(f, g)
      const out = await claim(f, g, quest)
      if (out.isError) {
        throw new Error('expected a lease')
      }
      return quest
    }
    async function openRun(f: GatewayGuardsFixture, g: string, quest: Quest) {
      return f.gateway.openRun(g, {
        questId: quest.id,
        attempt: 1,
        hallId: 'heralds',
        profileId: 'cloud-mid',
      })
    }
    async function started(f: GatewayGuardsFixture, g: string, quest: Quest): Promise<string> {
      const out = await openRun(f, g, quest)
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
      const quest = await leased(f, g)
      await pause(f, g)
      const refused: unknown = await openRun(f, g, quest)
      expect(refused).toEqual({ status: 'refused', reason: 'hall_paused' })
      await f.tripwires.resume(g, 'heralds')
      expect((await openRun(f, g, quest)).status).toBe('started')
    })

    test('a run active when the Hall is paused is refused before reserve and before the provider', async () => {
      const f = await make()
      const g = await f.newGuild()
      f.provider.script(OK)
      const token = await started(f, g, await leased(f, g))
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
      const token = await started(f, g, await leased(f, g))
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
      const questB = await leased(f, b)
      const tokenA = await started(f, a, await leased(f, a))
      const tokenB = await started(f, b, questB)
      await pause(f, b)
      expect(await codeOf(f.gateway.complete(tokenB, message))).toBe('hall_paused')
      expect(await codeOf(f.gateway.complete(tokenA, message))).toBe('no error')
      expect((await openRun(f, a, await leased(f, a))).status).toBe('started')
      const second: unknown = await openRun(f, b, questB)
      expect(second).toEqual({ status: 'refused', reason: 'hall_paused' })
      const quest = await post(f, a)
      expect((await claim(f, a, quest)).isError).toBe(false)
    })

    describe('Bar the Gates', () => {
      const actor = (guildId: string) => ({ guildId, memberId: crypto.randomUUID() })
      const handle = async (f: GatewayGuardsFixture, g: string, quest: Quest) =>
        lease.parse((await claim(f, g, quest)).data.lease)
      const put = (f: GatewayGuardsFixture, handleOf: z.infer<typeof lease>) =>
        callTool((r) => f.mcp.handle(r), 'put_artifact', {
          lease: handleOf,
          contentBase64: Buffer.from('x').toString('base64'),
        })

      test('a barred guild refuses tool calls, model calls, new runs and queue claims before any work', async () => {
        const f = await make()
        const g = await f.newGuild()
        f.provider.script(OK)
        const live = await post(f, g)
        const held = await handle(f, g, live)
        const token = await started(f, g, live)
        const spare = await post(f, g)
        const assignment = await f.mcp.assign(g, spare)
        await f.gates.bar(actor(g), 'guild')
        try {
          const before = f.provider.seen.length
          expect(await codeOf(f.gateway.complete(token, message))).toBe('gates_barred')
          expect(f.provider.seen.length).toBe(before)
          expect((await f.gateway.usage(g, 'run', { limit: 10 })).rows).toEqual([])
          expect(await openRun(f, g, live)).toEqual({ status: 'refused', reason: 'gates_barred' })
          const tool = await put(f, held)
          expect([tool.status, tool.rpcError]).toEqual([401, 'gates_barred'])
          const claimed = await callTool((r) => f.mcp.handle(r), 'claim_quest', { assignment })
          expect([claimed.status, claimed.rpcError]).toEqual([401, 'gates_barred'])
          expect(await f.quests.claim(g, { leaseMs: 60_000, maxActive: 10 })).toBeNull()
        } finally {
          await f.gates.lift(actor(g), 'guild')
        }
      })

      test('barring revokes every run token for good: lifting reissues nothing', async () => {
        const f = await make()
        const g = await f.newGuild()
        f.provider.script(OK)
        const live = await leased(f, g)
        const token = await started(f, g, live)
        const outcome = await f.gates.bar(actor(g), 'guild')
        expect(outcome.revokedRuns).toBe(1)
        await f.gates.lift(actor(g), 'guild')
        expect(await codeOf(f.gateway.complete(token, message))).toBe('token_revoked')
        expect(await openRun(f, g, live)).toEqual({ status: 'refused', reason: 'token_revoked' })
      })

      test("barring kills the guild's sandboxes and no other guild's", async () => {
        const f = await make()
        const a = await f.newGuild()
        const b = await f.newGuild()
        await f.sandboxes.start(a, { questId: 'q1' })
        await f.sandboxes.start(b, { questId: 'q2' })
        const outcome = await f.gates.bar(actor(a), 'guild')
        try {
          expect(outcome.killedSandboxes).toBe(1)
          expect(await f.sandboxes.list(a)).toEqual([])
          expect(await f.sandboxes.list(b)).toHaveLength(1)
        } finally {
          await f.gates.lift(actor(a), 'guild')
        }
      })

      test("one guild's bar leaves another guild's tools, model calls and queue working", async () => {
        const f = await make()
        const a = await f.newGuild()
        const b = await f.newGuild()
        f.provider.script(OK)
        const questB = await post(f, b)
        const heldB = await handle(f, b, questB)
        const tokenB = await started(f, b, questB)
        await f.gates.bar(actor(a), 'guild')
        try {
          expect(await codeOf(f.gateway.complete(tokenB, message))).toBe('no error')
          expect((await put(f, heldB)).isError).toBe(false)
          const next = await post(f, b)
          expect((await claim(f, b, next)).isError).toBe(false)
        } finally {
          await f.gates.lift(actor(a), 'guild')
        }
      })

      test("a global bar stops every guild, revokes every guild's tokens and kills every sandbox", async () => {
        const f = await make()
        const a = await f.newGuild()
        const b = await f.newGuild()
        f.provider.script(OK)
        const liveB = await leased(f, b)
        const tokenB = await started(f, b, liveB)
        await f.sandboxes.start(a, { questId: 'q1' })
        await f.sandboxes.start(b, { questId: 'q2' })
        try {
          await f.gates.bar(actor(a), 'global')
          expect(await codeOf(f.gateway.complete(tokenB, message))).toBe('gates_barred')
          expect(await f.quests.claim(b, { leaseMs: 60_000, maxActive: 10 })).toBeNull()
          expect(await f.sandboxes.list(a)).toEqual([])
          expect(await f.sandboxes.list(b)).toEqual([])
        } finally {
          await f.gates.lift(actor(a), 'global')
        }
        expect(await codeOf(f.gateway.complete(tokenB, message))).toBe('token_revoked')
      })

      test('barring again re-runs the stop steps, so a partial bar can be finished', async () => {
        const f = await make()
        const g = await f.newGuild()
        await f.gates.bar(actor(g), 'guild')
        try {
          await f.sandboxes.start(g, { questId: 'q1' })
          const again = await f.gates.bar(actor(g), 'guild')
          expect(again.created).toBe(false)
          expect(again.killedSandboxes).toBe(1)
        } finally {
          await f.gates.lift(actor(g), 'guild')
        }
      })

      test('the whole bar path completes within a tight bound and calls kill', async () => {
        const f = await make()
        const g = await f.newGuild()
        f.provider.script(OK)
        await started(f, g, await leased(f, g))
        await f.sandboxes.start(g, { questId: 'q1' })
        const t0 = performance.now()
        const outcome = await f.gates.bar(actor(g), 'guild')
        const elapsed = performance.now() - t0
        try {
          expect(outcome.killedSandboxes).toBe(1)
          expect(elapsed).toBeLessThan(1_000)
        } finally {
          await f.gates.lift(actor(g), 'guild')
        }
      })
    })

    describe('Quest attempt binding', () => {
      const LEASE_MS = 10 * 60 * 1000
      const attemptRun = (
        f: GatewayGuardsFixture,
        g: string,
        quest: { id: string },
        attempt: number
      ): Promise<unknown> =>
        f.gateway.openRun(g, {
          questId: quest.id,
          attempt,
          hallId: 'heralds',
          profileId: 'cloud-mid',
        })

      test("a lapsed lease's token is refused once the Quest is re-claimed, before the provider", async () => {
        const f = await make()
        const g = await f.newGuild()
        const quest = await post(f, g)
        expect((await claim(f, g, quest)).isError).toBe(false)
        const first = z
          .object({ status: z.literal('started'), token: z.string() })
          .parse(await attemptRun(f, g, quest, 1))
        f.clock.advance(LEASE_MS + 1_000)
        const second = await claim(f, g, quest)
        expect(lease.parse(second.data.lease).attempt).toBe(2)
        const before = f.provider.seen.length
        expect(await codeOf(f.gateway.complete(first.token, message))).toBe('token_revoked')
        expect(f.provider.seen.length).toBe(before)
      })

      test('the token of the current attempt keeps working; a lapsed lease alone also stops it', async () => {
        const f = await make()
        const g = await f.newGuild()
        f.provider.script(OK)
        const quest = await post(f, g)
        await claim(f, g, quest)
        const run = z.object({ token: z.string() }).parse(await attemptRun(f, g, quest, 1))
        expect(await codeOf(f.gateway.complete(run.token, message))).toBe('no error')
        f.clock.advance(LEASE_MS + 1_000)
        expect(await codeOf(f.gateway.complete(run.token, message))).toBe('token_revoked')
      })

      test("a run for another guild's Quest, a stale attempt or a lapsed lease is refused with no run row", async () => {
        const f = await make()
        const a = await f.newGuild()
        const b = await f.newGuild()
        const quest = await post(f, a)
        await claim(f, a, quest)
        expect(await attemptRun(f, b, quest, 1)).toEqual({
          status: 'refused',
          reason: 'quest_not_found',
        })
        expect(await f.ledger.getRun(b, `${quest.id}:1`)).toBeNull()
        expect(await attemptRun(f, a, quest, 2)).toEqual({
          status: 'refused',
          reason: 'quest_not_found',
        })
        f.clock.advance(LEASE_MS + 1_000)
        expect(await attemptRun(f, a, quest, 1)).toEqual({
          status: 'refused',
          reason: 'quest_not_found',
        })
        expect(await f.ledger.getRun(a, `${quest.id}:1`)).toBeNull()
      })
    })
  })
}
