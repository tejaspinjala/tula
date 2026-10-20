import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { MemoryClock } from './adapters/memory-clock'
import type { MemoryModelProvider } from './adapters/memory-model-provider'
import { costPerPost } from './cost-per-post'
import type { Dispatcher } from './dispatch'
import type { Gates } from './gates'
import { defaultConfig } from './guild-config'
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
  /** The Heralds Hall's `maxConcurrentMembers`. */
  memberCap?: number
}

/** The default Halls with the Heralds Hall's member cap from `options`; both worlds build their config from it. */
export function hallsFor(options: GuildOptions): ReturnType<typeof defaultConfig>['halls'] {
  return defaultConfig().halls.map((h) =>
    h.id === 'heralds' && options.memberCap !== undefined
      ? { ...h, maxConcurrentMembers: options.memberCap }
      : h
  )
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

    describe('subagents', () => {
      const parentBrief = 'Summarise two topics'
      const startsQuest = async (w: E2eWorld, guild: string, questId: string) =>
        expect(await w.dispatcher.dispatch(guild)).toMatchObject({ status: 'started', questId })
      const handleOf = (w: E2eWorld, questId: string) =>
        lease.parse(JSON.parse(w.sandboxes.latest(questId).leaseHandle ?? 'null'))
      const postParent = (w: E2eWorld, guild: string) =>
        post(w, guild, {
          templateId: 'herald-brief',
          rank: 'journeyman',
          dataClass: 'internal',
          ownerId: 'heralds-member-2',
          doneCondition: parentBrief,
          jobKey: 'parent',
        })
      /** The parent's worker on its first delivery: spawn two Sub-Quests and wait for them. */
      const parentSpawns = async (w: E2eWorld, parentId: string) => {
        const handle = handleOf(w, parentId)
        const call = (name: string, args: object) =>
          callTool((request) => w.mcp.handle(request), name, { lease: handle, ...args })
        const spawned = []
        for (const topic of ['A', 'B']) {
          spawned.push(
            await call('spawn_subquest', {
              title: `Topic ${topic}`,
              brief: `Research topic ${topic}`,
              template: 'herald-brief',
            })
          )
        }
        return { spawned, waiting: await call('await_children', {}) }
      }

      test('a parent spawns two Sub-Quests, gives up its slot, resumes and finishes with their results', async () => {
        const w = await make()
        const { guildId } = await w.newGuild()
        const parent = await postParent(w, guildId)
        await dispatchStarts(w, guildId, parent)
        const parentToken = w.sandboxes.latest(parent.id).runToken ?? ''
        const { spawned, waiting } = await parentSpawns(w, parent.id)
        expect(spawned.map((s) => s.isError)).toEqual([false, false])
        expect(waiting.data.waiting).toBe(true)
        expect(await w.quests.get(guildId, parent.id)).toMatchObject({
          state: 'queued',
          leaseExpiresAt: null,
        })
        // Parking retires the parent's run: its token is revoked and its sandbox is gone, so it
        // cannot keep calling the model outside the worker-slot count.
        expect((await w.ledger.getRun(guildId, runIdFor(parent.id, 1)))?.state).toBe('revoked')
        await expect(
          w.gateway.complete(parentToken, {
            messages: [{ role: 'user', content: 'x' }],
            maxTokens: 10,
          })
        ).rejects.toMatchObject({ code: 'token_revoked' })
        expect((await w.sandboxes.list(guildId)).map((sb) => sb.questId)).not.toContain(parent.id)
        const kids = spawned.map((s) => z.string().parse(s.data.childId))
        // The parent holds no worker slot: the children are dispatched, one per pass, to normal workers.
        for (const [i, kid] of kids.entries()) {
          await startsQuest(w, guildId, kid)
          const run = await memberWorks(w, guildId, kid, `Findings ${i}`)
          expect(run.completion.data.state).toBe('done')
        }
        await startsQuest(w, guildId, parent.id)
        expect(await w.quests.get(guildId, parent.id)).toMatchObject({
          state: 'active',
          attempts: 2,
        })
        const handle = handleOf(w, parent.id)
        const results = await callTool((r) => w.mcp.handle(r), 'child_results', { lease: handle })
        const children = z
          .array(z.object({ status: z.string(), result: z.object({ summary: z.string() }) }))
          .parse(results.data.children)
        expect(children.map((c) => c.status)).toEqual(['done', 'done'])
        const run = await new ScriptedMember((r) => w.mcp.handle(r), {
          goal: 'Summarised both topics',
          output: () => children.map((c) => c.result.summary).join('; '),
        }).runLeased(handle)
        expect(run.completion.data.state).toBe('done')
        expect(await stateOf(w, guildId, parent.id)).toBe('done')
        expect(await w.quests.linkOf(guildId, kids[0] ?? '')).toMatchObject({
          parentId: parent.id,
          depth: 1,
        })
      })

      test('barring the Gates mid-tree stops every Sub-Quest and revokes their leases', async () => {
        const w = await make()
        const { guildId, masterId } = await w.newGuild()
        const parent = await postParent(w, guildId)
        await dispatchStarts(w, guildId, parent)
        const { spawned } = await parentSpawns(w, parent.id)
        const kids = spawned.map((s) => z.string().parse(s.data.childId))
        const oldTokens = [w.sandboxes.latest(parent.id).runToken ?? '']
        for (const kid of kids) {
          await startsQuest(w, guildId, kid)
          oldTokens.push(w.sandboxes.latest(kid).runToken ?? '')
        }
        expect((await w.sandboxes.list(guildId)).length).toBeGreaterThan(0)
        const actor = { guildId, memberId: masterId }
        await w.gates.bar(actor, 'guild')
        // Every member of the tree has a revoked run: the parent's first attempt and each child's.
        for (const [id, attempt] of [
          [parent.id, 1],
          ...kids.map((k) => [k, 1] as const),
        ] as const) {
          expect((await w.ledger.getRun(guildId, runIdFor(id, attempt)))?.state).toBe('revoked')
        }
        expect(await w.sandboxes.list(guildId)).toEqual([])
        for (const kid of kids) {
          expect(await w.quests.get(guildId, kid)).toMatchObject({
            state: 'queued',
            leaseExpiresAt: null,
          })
        }
        expect(await w.dispatcher.dispatch(guildId)).toEqual({ status: 'barred' })
        const denied = await callTool((r) => w.mcp.handle(r), 'spawn_subquest', {
          lease: handleOf(w, kids[0] ?? ''),
          title: 'x',
          brief: 'y',
          template: 'herald-brief',
        })
        expect(denied.rpcError).toBe('gates_barred')
        // Lifting the bar does not bring the old tokens back; the tree resumes on new runs.
        expect(await w.gates.lift(actor, 'guild')).toBe(true)
        w.clock.advance(60 * 60_000)
        for (const token of oldTokens) {
          await expect(
            w.gateway.complete(token, { messages: [{ role: 'user', content: 'x' }], maxTokens: 10 })
          ).rejects.toMatchObject({ code: 'token_revoked' })
        }
        for (const [i, kid] of kids.entries()) {
          await startsQuest(w, guildId, kid)
          await memberWorks(w, guildId, kid, `Findings ${i}`)
        }
        await startsQuest(w, guildId, parent.id)
        const resumed = await w.quests.get(guildId, parent.id)
        expect(resumed?.state).toBe('active')
        const fresh = runIdFor(parent.id, resumed?.attempts ?? 0)
        expect(fresh).not.toBe(runIdFor(parent.id, 1))
        expect((await w.ledger.getRun(guildId, fresh))?.state).toBe('active')
      })
    })

    describe('hall teams', () => {
      const handleOf = (w: E2eWorld, questId: string) =>
        lease.parse(JSON.parse(w.sandboxes.latest(questId).leaseHandle ?? 'null'))
      const startsQuest = async (w: E2eWorld, guild: string, questId: string) =>
        expect(await w.dispatcher.dispatch(guild)).toMatchObject({ status: 'started', questId })
      const startCampaign = (w: E2eWorld, guild: string) =>
        w.quests.post(guild, {
          jobKey: 'team:launch',
          campaignId: 'launch',
          templateId: 'team-plan',
          hallId: 'heralds',
          rank: 'journeyman',
          dataClass: 'internal',
          title: 'Plan the Campaign: ship the launch',
          ownerId: 'heralds-captain',
          doneCondition: 'Plan and post the board',
          roundLimit: 2,
        })
      /** The scripted Captain's run: it plans, posts three Quests to the Hall's board, then finishes. */
      const captainPosts = async (w: E2eWorld, guild: string, captainQuestId: string) => {
        const handle = handleOf(w, captainQuestId)
        const posted: string[] = []
        const member = new ScriptedMember((r) => w.mcp.handle(r), {
          goal: 'Plan',
          output: () => 'The plan',
          afterArtifact: async () => {
            for (const n of [1, 2, 3]) {
              const out = await callTool((r) => w.mcp.handle(r), 'post_to_board', {
                lease: handle,
                title: `Section ${n}`,
                brief: `Write section ${n}`,
                template: 'herald-brief',
              })
              posted.push(z.string().parse(out.data.questId))
            }
          },
        })
        const run = await member.runLeased(handle)
        expect(run.completion.isError).toBe(false)
        return posted
      }

      test('a scripted Captain posts three Quests and two Members claim and finish them under a cap of two', async () => {
        const w = await make()
        const { guildId } = await w.newGuild({ memberCap: 2 })
        const { quest: captain } = await startCampaign(w, guildId)
        await dispatchStarts(w, guildId, captain)
        const board = await captainPosts(w, guildId, captain.id)
        expect(board).toHaveLength(3)
        expect((await w.quests.get(guildId, captain.id))?.state).toBe('done')
        // Two Members claim at once; the third waits queued, not failed.
        await startsQuest(w, guildId, board[0] ?? '')
        await startsQuest(w, guildId, board[1] ?? '')
        expect(await w.dispatcher.dispatch(guildId)).toEqual({ status: 'idle' })
        expect((await w.quests.get(guildId, board[2] ?? ''))?.state).toBe('queued')
        // A Member finishing frees a slot for the third.
        await memberWorks(w, guildId, board[0] ?? '', 'Section one')
        await startsQuest(w, guildId, board[2] ?? '')
        await memberWorks(w, guildId, board[1] ?? '', 'Section two')
        await memberWorks(w, guildId, board[2] ?? '', 'Section three')
        const finished = await Promise.all(board.map((id) => w.quests.get(guildId, id)))
        expect(finished.map((q) => q?.state)).toEqual(['done', 'done', 'done'])
        expect(new Set(finished.map((q) => q?.ownerId))).toEqual(new Set(['heralds-member-2']))
      })

      test('a bar stops the team: nothing dispatches and the Captain`s lease opens nothing', async () => {
        const w = await make()
        const { guildId, masterId } = await w.newGuild({ memberCap: 2 })
        const { quest: captain } = await startCampaign(w, guildId)
        await dispatchStarts(w, guildId, captain)
        const handle = handleOf(w, captain.id)
        await w.gates.bar({ guildId, memberId: masterId }, 'guild')
        expect(await w.dispatcher.dispatch(guildId)).toEqual({ status: 'barred' })
        const denied = await callTool((r) => w.mcp.handle(r), 'post_to_board', {
          lease: handle,
          title: 'x',
          brief: 'y',
          template: 'herald-brief',
        })
        expect(denied.rpcError).toBe('gates_barred')
      })
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
