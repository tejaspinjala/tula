import { afterAll, describe, expect, test } from 'bun:test'
import { MemorySandboxRunner } from './adapters/memory-sandbox-runner'
import { defaultConfig, guildConfig } from './guild-config'
import type { OpenRunResult } from './model-gateway'
import type { Sandbox, SandboxSpec } from './ports/sandbox-runner'
import { SUMMON_JOB_KEY, Summon } from './summon'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const harness = await createHarness({ devGuildHeader: true })
afterAll(async () => {
  await harness.close()
})

/** A founded guild with an api_key provider and one profile. */
async function found() {
  const g = await harness.foundGuild({ name: 'Summon failures', goal: 'g' })
  await harness.adapters.config.seed(g)
  const next = guildConfig.parse({
    ...defaultConfig(),
    providers: [{ id: 'cloud', auth: 'api_key' }],
    routingProfiles: [
      {
        id: 'cloud-mid',
        provider: 'cloud',
        tier: 'mid',
        model: 'm',
        price: { inputMicrosPerMTok: 1, outputMicrosPerMTok: 1 },
      },
    ],
  })
  const proposed = await harness.adapters.config.propose(g, next)
  if (proposed.status === 'pending') {
    await harness.adapters.config.confirm(g, proposed.version)
  }
  return g
}

/** A Summon over the harness's real stores, with a stubbed run gateway and sandbox runner. */
function summonWith(
  open: () => OpenRunResult,
  sandboxes: {
    start: (g: string, s: SandboxSpec) => Promise<Sandbox>
    kill: MemorySandboxRunner['kill']
  }
) {
  const a = harness.adapters
  return new Summon({
    config: a.config,
    quests: a.quests,
    tripwires: a.tripwires,
    gates: { isBarred: async (g) => (await a.gates.status(g)).guild },
    gateway: { openRun: async () => open(), runRevoked: async () => false },
    mcp: a.mcp,
    sandboxes,
    clock: a.clock,
  })
}

const refused: OpenRunResult = { status: 'refused', reason: 'hall_paused' }

describe('Summon failure paths', () => {
  test('a refused run releases the claimed Quest so it can be claimed again', async () => {
    const g = await found()
    const summon = summonWith(() => refused, new MemorySandboxRunner())
    const result = await summon.start(g, 'cloud-mid')
    expect(result).toEqual({ ok: false, error: 'run_not_started' })
    const quest = await harness.adapters.quests.findByJobKey(g, SUMMON_JOB_KEY)
    expect(quest?.state).toBe('queued')
    expect(quest?.leaseExpiresAt).toBeNull()
    harness.adapters.clock.advance(10 * 60_000)
    const again = await harness.adapters.quests.claim(g, {
      leaseMs: 60_000,
      maxActive: 10,
      ...(quest ? { questId: quest.id } : {}),
    })
    expect(again?.id).toBe(quest?.id)
  })

  test('a sandbox that fails to start records its own failure reason', async () => {
    const g = await found()
    const summon = summonWith(
      () => ({ status: 'started', token: 't', expiresAt: '2030-01-01T00:00:00.000Z' }),
      {
        start: async () => {
          throw new Error('docker down')
        },
        kill: async () => 0,
      }
    )
    expect(await summon.start(g, 'cloud-mid')).toEqual({ ok: false, error: 'sandbox_unavailable' })
    const quest = await harness.adapters.quests.findByJobKey(g, SUMMON_JOB_KEY)
    expect(String(quest?.lastError)).toBe('sandbox_unavailable')
  })

  test('a bar that lands while the sandbox starts leaves no container behind', async () => {
    const g = await found()
    const runner = new MemorySandboxRunner()
    const summon = summonWith(
      () => ({ status: 'started', token: 't', expiresAt: '2030-01-01T00:00:00.000Z' }),
      {
        start: async (guild, spec) => {
          await harness.adapters.gates.bar(
            { guildId: guild, memberId: (await memberOf(guild)) ?? '' },
            'guild'
          )
          return runner.start(guild, spec)
        },
        kill: (target) => runner.kill(target),
      }
    )
    const result = await summon.start(g, 'cloud-mid')
    expect(result).toEqual({ ok: false, error: 'gates_barred' })
    expect(await runner.list(g)).toEqual([])
    const quest = await harness.adapters.quests.findByJobKey(g, SUMMON_JOB_KEY)
    expect(quest?.state).toBe('queued')
    expect(quest?.leaseExpiresAt).toBeNull()
  })

  test('a bar during start with a failing kill ends the Quest failed, with a coded result', async () => {
    const g = await found()
    const runner = new MemorySandboxRunner()
    const summon = summonWith(
      () => ({ status: 'started', token: 't', expiresAt: '2030-01-01T00:00:00.000Z' }),
      {
        start: async (guild, spec) => {
          await harness.adapters.gates.bar(
            { guildId: guild, memberId: (await memberOf(guild)) ?? '' },
            'guild'
          )
          return runner.start(guild, spec)
        },
        kill: async () => {
          throw new Error('docker unreachable')
        },
      }
    )
    expect(await summon.start(g, 'cloud-mid')).toEqual({ ok: false, error: 'sandbox_unavailable' })
    const quest = await harness.adapters.quests.findByJobKey(g, SUMMON_JOB_KEY)
    expect(quest?.state).toBe('queued')
    expect(quest?.leaseExpiresAt).toBeNull()
    expect(String(quest?.lastError)).toBe('sandbox_unavailable')
  })
})

/** The founding member of the guild, as a session resolves it. */
async function memberOf(guildId: string): Promise<string | undefined> {
  const token = await openSession(harness.adapters.identity, guildId)
  return (await harness.adapters.identity.resolveSession(token))?.memberId
}
