import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { MemoryClock } from './adapters/memory-clock'
import type { MemoryModelProvider } from './adapters/memory-model-provider'
import { costPerPost } from './cost-per-post'
import type { Dispatcher } from './dispatch'
import type { Gates } from './gates'
import type { McpGateway } from './mcp/gateway'
import { GatewayError, type ModelGateway, runIdFor } from './model-gateway'
import type { ModelLedger } from './ports/model-ledger'
import type { PostCostReader } from './ports/post-cost-reader'
import type { NewQuest, Quest, QuestQueue } from './ports/quest-queue'
import { SEAL_RESERVATION_MS, type Seal, type SealStore } from './ports/seal-store'
import type { ProposalEngine } from './proposals'
import type { SealEngine } from './seals'
import type { RecordingSandboxRunner } from './testing/recording-sandbox'
import { callTool, ScriptedMember } from './testing/scripted-member'
import type { ContentPolicy } from './verdict'
import type { WorkflowEngine } from './workflows/engine'

/** What a guild needs from {@link E2eWorld.newGuild}. */
export interface GuildOptions {
  /** The Verdict's policy, fed through guild config. */
  contentPolicy?: ContentPolicy
  /** Daily caps; zero exhausts the budget so routing blocks transiently. */
  caps?: { dailyTokens: number; dailySpendCents: number }
}

/** Everything the end-to-end suite drives: the real engines over memory or Postgres adapters. */
export interface E2eWorld {
  clock: MemoryClock
  quests: QuestQueue
  sealStore: SealStore
  seals: SealEngine
  proposals: ProposalEngine
  /** The workflow engine over the same queue, Seals and Proposals. */
  workflows: WorkflowEngine
  dispatcher: Pick<Dispatcher, 'dispatch'>
  gateway: ModelGateway
  mcp: McpGateway
  gates: Gates
  ledger: ModelLedger
  postCosts: PostCostReader
  provider: MemoryModelProvider
  sandboxes: RecordingSandboxRunner
  /** A guild with one api-key provider priced at 3 and 15 per million tokens, and its Guild Master's member id. */
  newGuild(options?: GuildOptions): Promise<{ guildId: string; masterId: string }>
}

/** 1000 input tokens at 3_000_000 and 500 output tokens at 15_000_000 micros per million. */
const CALL_COST_MICROS = 10_500
const lease = z.object({ questId: z.string(), attempt: z.number(), token: z.string() })

/**
 * The Core Loop, end to end through the real engines and `dispatch()`, with a scripted Member and
 * the memory model provider (no real model). Run it once per adapter family; `make` builds a
 * fresh world.
 */
export function coreLoopEndToEnd(name: string, make: () => Promise<E2eWorld>): void {
  describe(`core loop end to end (${name})`, () => {
    const post = async (w: E2eWorld, guild: string, over: Partial<NewQuest> = {}): Promise<Quest> =>
      (
        await w.quests.post(guild, {
          jobKey: crypto.randomUUID(),
          templateId: 'herald-announcement',
          hallId: 'heralds',
          rank: 'apprentice',
          dataClass: 'public',
          title: 'Announce',
          ownerId: 'heralds-member-1',
          doneCondition: 'An announcement draft is ready for a Seal',
          roundLimit: 2,
          ...over,
        })
      ).quest

    const dispatchStarts = async (w: E2eWorld, guild: string, quest: Quest) =>
      expect(await w.dispatcher.dispatch(guild)).toMatchObject({
        status: 'started',
        questId: quest.id,
      })

    /** The scripted Member's work on a dispatched Quest: one metered model call, then the loop's tools. */
    const memberWorks = async (w: E2eWorld, guild: string, questId: string, content: string) => {
      const spec = w.sandboxes.latest(questId)
      const handle = lease.parse(JSON.parse(spec.leaseHandle ?? 'null'))
      const quest = await w.quests.get(guild, questId)
      if (!(quest && spec.runToken)) {
        throw new Error('the sandbox was handed no Quest or run token')
      }
      // The Brief comes from the MCP tool, as a real worker's does, not from the test.
      const read = await callTool((request) => w.mcp.handle(request), 'read_brief', {
        lease: handle,
      })
      const brief = z.string().parse(read.data.brief)
      w.provider.script({
        ok: true,
        text: content,
        usage: { inputTokens: 1000, outputTokens: 500 },
      })
      const reply = await w.gateway.complete(spec.runToken, {
        messages: [{ role: 'user', content: brief }],
        maxTokens: 1000,
      })
      const member = new ScriptedMember((request) => w.mcp.handle(request), {
        goal: 'Announce',
        output: () => reply.text,
      })
      return member.runLeased(handle)
    }

    /** Posts, dispatches and works a Quest, then dispatches again so its Seal is requested. */
    const sealRequested = async (
      w: E2eWorld,
      guild: string,
      content: string,
      over: Partial<NewQuest> = {}
    ) => {
      const quest = await post(w, guild, over)
      await dispatchStarts(w, guild, quest)
      const run = await memberWorks(w, guild, quest.id, content)
      expect(run.completion.data.state).toBe('awaiting_seal')
      await w.dispatcher.dispatch(guild)
      return { quest, seal: await w.sealStore.forQuest(guild, quest.id) }
    }

    const decide = (
      w: E2eWorld,
      guild: string,
      masterId: string,
      seal: Seal,
      verdict: 'approved' | 'denied'
    ) =>
      w.seals.decide(
        guild,
        seal.id,
        { verdict, expectedHash: seal.actionHash },
        { role: 'guild_master', id: masterId }
      )
    const stateOf = async (w: E2eWorld, guild: string, id: string) =>
      (await w.quests.get(guild, id))?.state

    test('post, work, Seal, approve, publish, reconcile: done, at the metered cost per post', async () => {
      const w = await make()
      const { guildId, masterId } = await w.newGuild()
      const { quest, seal } = await sealRequested(w, guildId, 'Hello guild')
      expect(await stateOf(w, guildId, quest.id)).toBe('awaiting_seal')
      const proposal = await w.proposals.latestForQuest(guildId, quest.id)
      expect(seal).toMatchObject({
        status: 'requested',
        text: 'Hello guild',
        round: 1,
        actionHash: proposal?.hash,
      })
      if (!seal) {
        throw new Error('no Seal was requested')
      }
      expect((await decide(w, guildId, masterId, seal, 'approved')).ok).toBe(true)
      const posted: string[] = []
      const published = await w.seals.publish(guildId, seal.id, seal.text, async () => {
        posted.push(seal.text)
      })
      expect(published.ok).toBe(true)
      expect(posted).toEqual(['Hello guild'])
      expect((await w.sealStore.get(guildId, seal.id))?.status).toBe('consumed')
      await w.dispatcher.dispatch(guildId)
      expect(await stateOf(w, guildId, quest.id)).toBe('done')

      const spend = await w.ledger.report(guildId, 'quest', { limit: 100 })
      expect(spend.rows.find((r) => r.key === quest.id)?.costMicros).toBe(CALL_COST_MICROS)
      const cost = await costPerPost({ postCosts: w.postCosts }, guildId, { limit: 10 })
      expect(cost.overall).toEqual({
        posts: 1,
        costMicros: CALL_COST_MICROS,
        costPerPostMicros: CALL_COST_MICROS,
      })
    })

    test('a crash between reserve and consume leaves the Seal reserved until the Guild Master resolves it with re-auth', async () => {
      const w = await make()
      const { guildId, masterId } = await w.newGuild()
      const { quest, seal } = await sealRequested(w, guildId, 'Crash post')
      if (!seal) {
        throw new Error('no Seal was requested')
      }
      await decide(w, guildId, masterId, seal, 'approved')
      await expect(
        w.seals.publish(guildId, seal.id, seal.text, async () => {
          throw new Error('the post call crashed')
        })
      ).rejects.toThrow('the post call crashed')
      expect((await w.sealStore.get(guildId, seal.id))?.status).toBe('reserved')
      await w.dispatcher.dispatch(guildId)
      expect(await stateOf(w, guildId, quest.id)).toBe('awaiting_seal')
      expect((await w.seals.publish(guildId, seal.id, seal.text, async () => {})).ok).toBe(false)
      // Only a reservation that has gone stale can be resolved by hand, and only with a fresh re-auth.
      w.clock.advance(SEAL_RESERVATION_MS + 1)
      expect(
        (await w.seals.markPosted(guildId, seal.id, seal.text, { reauthenticated: false })).ok
      ).toBe(false)
      expect(
        (await w.seals.markPosted(guildId, seal.id, seal.text, { reauthenticated: true })).ok
      ).toBe(true)
      await w.dispatcher.dispatch(guildId)
      expect(await stateOf(w, guildId, quest.id)).toBe('done')
    })

    test('a denied Seal is a revision round with a new Seal row; the last round dead-letters and cascades', async () => {
      const w = await make()
      const { guildId, masterId } = await w.newGuild()
      const { quest, seal: first } = await sealRequested(w, guildId, 'First draft')
      if (!first) {
        throw new Error('no Seal was requested')
      }
      const child = await post(w, guildId, { blockedBy: [quest.id], jobKey: 'dependent' })
      await decide(w, guildId, masterId, first, 'denied')
      // The pass settles the denial into round 2 and claims the revision.
      await dispatchStarts(w, guildId, quest)
      expect(await w.quests.get(guildId, quest.id)).toMatchObject({
        round: 1,
        state: 'active',
        lastError: 'seal_rejected',
      })
      await memberWorks(w, guildId, quest.id, 'Second draft')
      await w.dispatcher.dispatch(guildId)
      const second = await w.sealStore.forQuest(guildId, quest.id)
      expect(second).toMatchObject({ round: 2, status: 'requested', text: 'Second draft' })
      expect(second?.id).not.toBe(first.id)
      if (!second) {
        throw new Error('no revision Seal was requested')
      }
      await decide(w, guildId, masterId, second, 'denied')
      await w.dispatcher.dispatch(guildId)
      expect(await stateOf(w, guildId, quest.id)).toBe('dead')
      expect(await w.quests.get(guildId, child.id)).toMatchObject({
        state: 'dead',
        lastError: 'blocker_dead',
      })
    })

    test('a failed Verdict requests no Seal and opens a revision round', async () => {
      const w = await make()
      const { guildId } = await w.newGuild({
        contentPolicy: { maxLength: 500, bannedTerms: ['free money'], requiredTerms: [] },
      })
      const { quest, seal } = await sealRequested(w, guildId, 'Get free money now')
      expect(seal).toBeNull()
      const after = await w.quests.get(guildId, quest.id)
      expect(after).toMatchObject({ round: 1, lastError: 'seal_rejected' })
      expect(after?.state).not.toBe('awaiting_seal')
      // The revision is the next round: its Seal, once the Verdict passes, is round 2.
      await memberWorks(w, guildId, quest.id, 'Get a fair price now')
      await w.dispatcher.dispatch(guildId)
      expect(await w.sealStore.forQuest(guildId, quest.id)).toMatchObject({
        round: 2,
        text: 'Get a fair price now',
      })
    })

    test('a guild barred mid-loop releases its leases and revokes run tokens; a lift lets dispatch claim again', async () => {
      const w = await make()
      const { guildId, masterId } = await w.newGuild()
      const quest = await post(w, guildId)
      await dispatchStarts(w, guildId, quest)
      const spec = w.sandboxes.latest(quest.id)
      const actor = { guildId, memberId: masterId }
      await w.gates.bar(actor, 'guild')
      expect(await w.dispatcher.dispatch(guildId)).toEqual({ status: 'barred' })
      expect(await w.sandboxes.list(guildId)).toEqual([])
      expect(await w.quests.get(guildId, quest.id)).toMatchObject({
        state: 'queued',
        leaseExpiresAt: null,
      })
      expect((await w.ledger.getRun(guildId, runIdFor(quest.id, 1)))?.state).toBe('revoked')
      await expect(
        w.gateway.complete(spec.runToken ?? '', {
          messages: [{ role: 'user', content: 'x' }],
          maxTokens: 10,
        })
      ).rejects.toBeInstanceOf(GatewayError)
      expect(await w.gates.lift(actor, 'guild')).toBe(true)
      w.clock.advance(60 * 60_000)
      await dispatchStarts(w, guildId, quest)
    })

    test('a transient routing block requeues with a notBefore and spends no attempt', async () => {
      const w = await make()
      const { guildId } = await w.newGuild({ caps: { dailyTokens: 0, dailySpendCents: 0 } })
      const quest = await post(w, guildId)
      expect(await w.dispatcher.dispatch(guildId)).toEqual({
        status: 'blocked',
        questId: quest.id,
        reason: 'budget_exhausted',
        disposition: 'retry_scheduled',
      })
      const after = await w.quests.get(guildId, quest.id)
      expect(after).toMatchObject({ state: 'queued', attempts: 1, lastError: 'routing_blocked' })
      expect(Date.parse(after?.notBefore ?? '')).toBeGreaterThan(w.clock.now().getTime())
      expect(await w.sandboxes.list(guildId)).toEqual([])
    })

    test('a workflow run reaches done through the normal dispatcher, Verdict and Seal; a restart posts nothing twice', async () => {
      const w = await make()
      const engine = w.workflows
      const { guildId, masterId } = await w.newGuild()
      await engine.seedTemplates(guildId)
      const run = await engine.run(guildId, 'learning-to-linkedin', { runKey: 'e2e' })
      if (!run.ok) {
        throw new Error(`run refused: ${run.error}`)
      }
      const restart = await engine.run(guildId, 'learning-to-linkedin', { runKey: 'e2e' })
      expect(restart).toMatchObject({ ok: true, created: false })
      const questId = run.quests[0]?.questId ?? ''
      const quest = await w.quests.get(guildId, questId)
      if (!quest) {
        throw new Error('the workflow posted no Quest')
      }
      expect(quest.campaignId).toBe(run.instance.id)
      expect((await w.quests.list(guildId, { limit: 10 })).quests).toHaveLength(1)

      await dispatchStarts(w, guildId, quest)
      const worked = await memberWorks(w, guildId, quest.id, 'What we learned this week')
      expect(worked.completion.data.state).toBe('awaiting_seal')
      await w.dispatcher.dispatch(guildId)
      const seal = await w.sealStore.forQuest(guildId, quest.id)
      if (!seal) {
        throw new Error('no Seal was requested')
      }
      const mid = await engine.state(guildId, run.instance.id)
      expect(mid?.nodes.map((n) => [n.id, n.status])).toEqual([
        ['start', 'done'],
        ['draft', 'awaiting_seal'],
        ['check', 'passed'],
        ['seal', 'awaiting'],
        ['publish', 'pending'],
      ])
      expect((await decide(w, guildId, masterId, seal, 'approved')).ok).toBe(true)
      expect((await w.seals.publish(guildId, seal.id, seal.text, async () => {})).ok).toBe(true)
      await w.dispatcher.dispatch(guildId)
      expect(await stateOf(w, guildId, quest.id)).toBe('done')
      const end = await engine.state(guildId, run.instance.id)
      expect(end?.nodes.map((n) => [n.id, n.status])).toEqual([
        ['start', 'done'],
        ['draft', 'done'],
        ['check', 'passed'],
        ['seal', 'approved'],
        ['publish', 'done'],
      ])
    })

    test('a permanent routing block kills the Quest with a coded reason', async () => {
      const w = await make()
      const { guildId } = await w.newGuild()
      const quest = await post(w, guildId, { hallId: 'nowhere' })
      expect(await w.dispatcher.dispatch(guildId)).toEqual({
        status: 'blocked',
        questId: quest.id,
        reason: 'hall_not_found',
        disposition: 'killed',
      })
      expect(await w.quests.get(guildId, quest.id)).toMatchObject({
        state: 'dead',
        lastError: 'hall_not_found',
      })
    })
  })
}
