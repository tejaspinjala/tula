import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { MemorySandboxRunner } from './adapters/memory-sandbox-runner'
import { defaultConfig, guildConfig } from './guild-config'
import type { Sandbox, SandboxSpec } from './ports/sandbox-runner'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'
import { callTool } from './testing/scripted-member'

/** A memory runner that remembers the spec each sandbox was started with. */
class RecordingRunner extends MemorySandboxRunner {
  readonly specs: SandboxSpec[] = []
  override async start(guildId: string, spec: SandboxSpec): Promise<Sandbox> {
    this.specs.push(spec)
    return super.start(guildId, spec)
  }
}

const runner = new RecordingRunner()
const provider = new MemoryModelProvider()
const harness = await createHarness({
  devGuildHeader: true,
  app: { modelProvider: provider, sandboxes: runner },
})
afterAll(async () => {
  await harness.close()
})

const json = { 'content-type': 'application/json' }
const statusBody = z.object({
  complete: z.boolean(),
  steps: z.array(z.object({ id: z.string(), done: z.boolean() })),
  quest: z.object({ id: z.string(), state: z.string() }).nullable(),
})
const errorBody = z.object({ error: z.string() })
const leaseHandle = z.object({ questId: z.string(), attempt: z.number(), token: z.string() })

/** A founded guild with a session; `auth` picks the provider of its one routing profile. */
async function found(auth: 'api_key' | 'subscription' | null) {
  const g = await harness.foundGuild({ name: 'Summon', goal: 'g' })
  await harness.adapters.config.seed(g)
  if (auth !== null) {
    const next = guildConfig.parse({
      ...defaultConfig(),
      providers: [{ id: 'cloud', auth }],
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
    const proposed = await harness.adapters.config.propose(g, next)
    if (proposed.status === 'pending') {
      await harness.adapters.config.confirm(g, proposed.version)
    }
    await harness.adapters.secrets.add(g, 'cloud', 'sk-summon-test-key')
  }
  const session = await openSession(harness.adapters.identity, g)
  const member = (await harness.adapters.identity.resolveSession(session))?.memberId ?? ''
  return { g, member, auth: { authorization: `Bearer ${session}` } }
}

const status = async (g: string, auth: Record<string, string>) =>
  statusBody.parse(await (await harness.request(`/guilds/${g}/summon`, { headers: auth })).json())

const summon = (g: string, auth: Record<string, string>, profileId = 'cloud-mid') =>
  harness.request(`/guilds/${g}/summon`, {
    method: 'POST',
    headers: { ...json, ...auth },
    body: JSON.stringify({ profileId }),
  })

/** Plays the sandboxed worker: one model call through the gateway, then files and completes over MCP. */
async function playWorker(spec: SandboxSpec) {
  provider.script({ ok: true, text: 'ready', usage: { inputTokens: 4, outputTokens: 2 } })
  const lease = leaseHandle.parse(JSON.parse(spec.leaseHandle ?? ''))
  const call = await harness.request('/gateway/complete', {
    method: 'POST',
    headers: { ...json, authorization: `Bearer ${spec.runToken}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 20 }),
  })
  expect(call.status).toBe(200)
  const transport = async (request: object) => {
    const res = await harness.request('/mcp', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(request),
    })
    return { status: res.status, body: await res.json() }
  }
  const put = await callTool(transport, 'put_artifact', {
    lease,
    contentBase64: Buffer.from('hello from the worker').toString('base64'),
  })
  const hash = z.string().parse(put.data.hash)
  const done = await callTool(transport, 'complete_quest', {
    lease,
    handoff: {
      goal: 'Prove the worker runs',
      doneCondition: spec.doneCondition,
      met: true,
      evidence: [{ kind: 'artifact', ref: hash }],
      openItems: [],
      artifacts: [hash],
    },
  })
  expect(done.isError).toBe(false)
}

describe('Summon your first member', () => {
  test('a guild with no provider has not summoned: nothing done, nothing running', async () => {
    const { g, auth } = await found(null)
    const s = await status(g, auth)
    expect(s.complete).toBe(false)
    expect(s.steps).toEqual([
      { id: 'provider', done: false },
      { id: 'test_quest', done: false },
    ])
    expect(s.quest).toBeNull()
  })

  test('a subscription provider is refused until spike #15, and nothing starts', async () => {
    const { g, auth } = await found('subscription')
    const before = runner.specs.length
    const res = await summon(g, auth)
    expect(res.status).toBe(422)
    expect(errorBody.parse(await res.json()).error).toBe('subscription_unsupported_until_spike_15')
    expect(runner.specs).toHaveLength(before)
    expect((await status(g, auth)).complete).toBe(false)
  })

  test('summoning starts the worker but stays incomplete until the test Quest passes', async () => {
    const { g, auth } = await found('api_key')
    const res = await summon(g, auth)
    expect(res.status).toBe(202)
    const started = statusBody.parse(await res.json())
    expect(started.complete).toBe(false)
    expect(started.steps).toEqual([
      { id: 'provider', done: true },
      { id: 'test_quest', done: false },
    ])
    expect(await harness.adapters.sandboxes.list(g)).toHaveLength(1)
    expect((await status(g, auth)).complete).toBe(false)

    const spec = runner.specs.at(-1)
    expect(spec?.runToken).toBeString()
    // The worker's credentials are its run token and lease handle; the provider key never leaves the Vault.
    expect(JSON.stringify(spec)).not.toContain('sk-summon-test-key')
    await playWorker(spec ?? { questId: '' })

    const finished = await status(g, auth)
    expect(finished.complete).toBe(true)
    expect(finished.quest?.state).toBe('done')
  })

  test('summoning twice starts one worker', async () => {
    const { g, auth } = await found('api_key')
    expect((await summon(g, auth)).status).toBe(202)
    expect((await summon(g, auth)).status).toBe(202)
    expect(await harness.adapters.sandboxes.list(g)).toHaveLength(1)
  })

  test('a barred guild summons nothing', async () => {
    const { g, member, auth } = await found('api_key')
    await harness.adapters.gates.bar({ guildId: g, memberId: member }, 'guild')
    const res = await summon(g, auth)
    expect(res.status).toBe(409)
    expect(errorBody.parse(await res.json()).error).toBe('gates_barred')
    expect(await harness.adapters.sandboxes.list(g)).toEqual([])
  })

  test('summoning needs a session', async () => {
    const { g } = await found('api_key')
    expect((await summon(g, {})).status).toBe(401)
    expect((await harness.request(`/guilds/${g}/summon`)).status).toBe(401)
  })

  test("one guild cannot read or start another's summon", async () => {
    const other = await found('api_key')
    const sessions = new Map<string, string>()
    await expectGuildIsolation(harness, {
      build: async (caller, target) => {
        const session =
          sessions.get(caller) ?? (await openSession(harness.adapters.identity, caller))
        sessions.set(caller, session)
        return [
          `/guilds/${target}/summon`,
          {
            method: 'POST',
            headers: { ...json, authorization: `Bearer ${session}` },
            body: JSON.stringify({ profileId: 'cloud-mid' }),
          },
        ]
      },
      snapshot: async () => status(other.g, other.auth),
    })
  })
})
