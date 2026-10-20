import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryRateLimiter } from './adapters/memory-rate-limiter'
import type { Quest } from './ports/quest-queue'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { callTool, type McpTransport, ScriptedMember } from './testing/scripted-member'

const harness = await createHarness()
afterAll(async () => {
  await harness.close()
})

const http: McpTransport = async (request) => {
  const res = await harness.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  return { status: res.status, body: await res.json() }
}

async function guildWithQuest(over: { campaignId?: string } = {}) {
  const guild = await harness.foundGuild({ name: 'Mcp', goal: 'g' })
  await harness.adapters.config.seed(guild)
  const quest = await postQuest(guild, over)
  return { guild, quest }
}

async function postQuest(guild: string, over: { campaignId?: string } = {}): Promise<Quest> {
  return (
    await harness.adapters.quests.post(guild, {
      jobKey: crypto.randomUUID(),
      templateId: 'herald-brief',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Draft the brief',
      ownerId: 'heralds-member-2',
      doneCondition: 'A draft brief is filed in the Archive',
      roundLimit: 2,
      ...over,
    })
  ).quest
}

describe('MCP gateway over HTTP, on the real stores', () => {
  test('a scripted Member runs claim, Brief, artifact, Handoff end to end', async () => {
    const { guild, quest } = await guildWithQuest()
    const member = new ScriptedMember(http, {
      goal: 'Draft the brief',
      output: (brief) => `Draft for ${brief.length} characters of Brief`,
    })
    const run = await member.run(await harness.adapters.mcp.assign(guild, quest))
    expect(run.completion).toMatchObject({ status: 200, isError: false })
    expect((await harness.adapters.quests.get(guild, quest.id))?.state).toBe('done')
    const bytes = await harness.adapters.objectStore.get(guild, run.artifactHash)
    expect(bytes).not.toBeNull()
  })

  test('missives carry ids and hashes only', async () => {
    const { guild, quest } = await guildWithQuest()
    const run = await new ScriptedMember(http, { goal: 'Draft', output: () => 'SECRET-BODY' }).run(
      await harness.adapters.mcp.assign(guild, quest)
    )
    const rows = await harness.owner`
      select type, payload from events
      where guild_id = ${guild} and type in ('handoff.recorded', 'artifact.attached')
      order by seq`
    expect(rows.map((r) => String(r.type))).toEqual(['artifact.attached', 'handoff.recorded'])
    const text = JSON.stringify(rows.map((r) => r.payload))
    expect(text).not.toContain('SECRET-BODY')
    expect(text).not.toContain('Draft')
    expect(text).toContain(run.artifactHash)
  })

  test('a lease handle opens nothing in another guild', async () => {
    const a = await guildWithQuest()
    const b = await guildWithQuest()
    const claim = await callTool(http, 'claim_quest', {
      assignment: await harness.adapters.mcp.assign(a.guild, a.quest),
    })
    const lease = z
      .object({ questId: z.string(), attempt: z.number(), token: z.string() })
      .parse(claim.data.lease)
    const put = await callTool(http, 'put_artifact', {
      lease,
      contentBase64: Buffer.from('a-only').toString('base64'),
    })
    const hash = String(put.data.hash)
    // Guild A's token aimed at guild B's Quest, and B's Quest id with A's attempt.
    const crossed = await callTool(http, 'get_artifact', {
      lease: { ...lease, questId: b.quest.id },
      hash,
    })
    expect(crossed).toMatchObject({ status: 401, rpcError: 'invalid_lease' })
    // Guild B's Member cannot read A's artifact by hash through its own lease.
    const bClaim = await callTool(http, 'claim_quest', {
      assignment: await harness.adapters.mcp.assign(b.guild, b.quest),
    })
    const bLease = z
      .object({ questId: z.string(), attempt: z.number(), token: z.string() })
      .parse(bClaim.data.lease)
    const read = await callTool(http, 'get_artifact', { lease: bLease, hash })
    expect(read.data.error).toBe('not_found')
  })

  test('the route gives a guild nothing about another guild', async () => {
    await expectGuildIsolation(harness, {
      build: async (caller, target) => {
        const mine = await postQuest(caller)
        const claim = await callTool(http, 'claim_quest', {
          assignment: await harness.adapters.mcp.assign(caller, mine),
        })
        const lease = z
          .object({ questId: z.string(), attempt: z.number(), token: z.string() })
          .parse(claim.data.lease)
        const theirs = (await harness.adapters.quests.list(target, { limit: 1 })).quests[0]
        const body = {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_artifact',
            arguments: {
              lease: { ...lease, questId: theirs?.id ?? crypto.randomUUID() },
              hash: 'a'.repeat(64),
            },
          },
        }
        return [
          '/mcp',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        ]
      },
      snapshot: async (guildId) => ({
        quests: await harness.adapters.quests.list(guildId, { limit: 100 }),
        notes: await harness.adapters.notes.list(guildId, { limit: 100 }),
      }),
    })
  })

  test('the route is rate limited per client', async () => {
    const limited = await createHarness({
      app: {
        rateLimiter: new MemoryRateLimiter(new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))),
        rateLimits: { mcp: { client: { limit: 2, windowMs: 60_000 } } },
      },
    })
    try {
      const statuses: number[] = []
      for (let i = 0; i < 3; i += 1) {
        const res = await limited.request('/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        })
        statuses.push(res.status)
      }
      expect(statuses).toEqual([200, 200, 429])
    } finally {
      await limited.close()
    }
  })

  test('a body that is not JSON is a 400, not an error page', async () => {
    const res = await harness.request('/mcp', { method: 'POST', body: 'nope' })
    expect(res.status).toBe(400)
  })
})
