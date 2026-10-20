import { describe, expect, test } from 'bun:test'
import { MemoryGateStore } from './adapters/memory-gate-store'
import { Gates } from './gates'
import type { GlobalEvent } from './ports/gate-store'

const OPERATOR = crypto.randomUUID()
const MANY = 200

/** A world of `n` guilds whose every collaborator logs what happened while the bar was up. */
function world(n: number) {
  const guilds = Array.from({ length: n }, () => crypto.randomUUID()).sort()
  const events = new Map<string, string[]>()
  const calls: string[] = []
  const barredAt: boolean[] = []
  let running = 0
  let failing: string | null = null
  let widest = 0
  const announceErrors: unknown[] = []
  const observe = async () => {
    barredAt.push(await slowStore.isBarred(guilds[0] ?? ''))
  }
  // Announcements are slow on purpose, so unbounded concurrency would show.
  class SlowStore extends MemoryGateStore {
    override async announceGlobal(guildId: string, event: GlobalEvent): Promise<boolean> {
      if (guildId === failing) {
        throw new Error('announce failed')
      }
      running += 1
      widest = Math.max(widest, running)
      await Bun.sleep(1)
      await observe()
      running -= 1
      return super.announceGlobal(guildId, event)
    }
  }
  const slowStore = new SlowStore((guildId, type) => {
    events.set(guildId, [...(events.get(guildId) ?? []), type])
  })
  const gates = new Gates({
    store: slowStore,
    runs: {
      revokeGuildRuns: async () => {
        calls.push('revokeGuildRuns')
        return 0
      },
      revokeAllRuns: async () => {
        calls.push('revokeAllRuns')
        await Bun.sleep(5)
        await observe()
        return 7
      },
    },
    quests: { releaseLeases: async () => 0, releaseAllLeases: async () => 0 },
    sandboxes: {
      kill: async () => {
        calls.push('kill')
        await observe()
        return 3
      },
    },
    guildIds: async (after, limit) =>
      guilds.filter((g) => after === undefined || g > after).slice(0, limit),
    onAnnounceError: (e) => announceErrors.push(e),
  })
  return {
    announceErrors,
    failAnnounceTo: (guildId: string | null) => {
      failing = guildId
    },
    guilds,
    gates,
    events,
    calls,
    barredAt,
    widest: () => widest,
  }
}

describe('a global bar over many guilds', () => {
  test('starts the kill first, revokes every token in one call and keeps the gates shut throughout', async () => {
    const w = world(MANY)
    const out = await w.gates.bar({ guildId: w.guilds[0] ?? '', memberId: OPERATOR }, 'global')
    await w.gates.settled()
    expect(w.calls).toEqual(['kill', 'revokeAllRuns'])
    expect(out).toMatchObject({ revokedRuns: 7, killedSandboxes: 3 })
    expect(w.barredAt.length).toBeGreaterThan(MANY)
    expect(w.barredAt.every(Boolean)).toBe(true)
  })

  test('tells every guild chain once, with at most 8 guilds in flight', async () => {
    const w = world(MANY)
    const actor = { guildId: w.guilds[0] ?? '', memberId: OPERATOR }
    await w.gates.bar(actor, 'global')
    await w.gates.bar(actor, 'global')
    await w.gates.settled()
    for (const g of w.guilds) {
      expect(w.events.get(g)).toEqual(['gates.barred'])
    }
    expect(w.widest()).toBeLessThanOrEqual(8)
    expect(w.widest()).toBeGreaterThan(1)
  })

  test('lifting it is told to every guild chain too', async () => {
    const w = world(MANY)
    const actor = { guildId: w.guilds[0] ?? '', memberId: OPERATOR }
    await w.gates.bar(actor, 'global')
    await w.gates.settled()
    expect(await w.gates.lift(actor, 'global')).toBe(true)
    await w.gates.settled()
    for (const g of w.guilds) {
      expect(w.events.get(g)).toEqual(['gates.barred', 'gates.lifted'])
    }
  })
})

describe('a global bar announces after it answers', () => {
  test('answers before the guild chains are told, and the announcements finish in the background', async () => {
    const w = world(MANY)
    await w.gates.bar({ guildId: w.guilds[0] ?? '', memberId: OPERATOR }, 'global')
    const told = [...w.events.values()].length
    expect(told).toBeLessThan(MANY)
    await w.gates.settled()
    expect([...w.events.values()].length).toBe(MANY)
  })

  test('a failed background announcement is reported, and a repeated bar finishes it', async () => {
    const w = world(20)
    const actor = { guildId: w.guilds[0] ?? '', memberId: OPERATOR }
    w.failAnnounceTo(w.guilds[5] ?? '')
    await w.gates.bar(actor, 'global')
    await w.gates.settled()
    expect(w.announceErrors).toHaveLength(1)
    expect(w.events.get(w.guilds[5] ?? '')).toBeUndefined()
    w.failAnnounceTo(null)
    await w.gates.bar(actor, 'global')
    await w.gates.settled()
    for (const g of w.guilds) {
      expect(w.events.get(g)).toEqual(['gates.barred'])
    }
  })

  test('a lift finishes a bar announcement that failed, before it tells the lift', async () => {
    const w = world(20)
    const actor = { guildId: w.guilds[0] ?? '', memberId: OPERATOR }
    w.failAnnounceTo(w.guilds[5] ?? '')
    await w.gates.bar(actor, 'global')
    await w.gates.settled()
    w.failAnnounceTo(null)
    expect(await w.gates.lift(actor, 'global')).toBe(true)
    await w.gates.settled()
    for (const g of w.guilds) {
      expect(w.events.get(g)).toEqual(['gates.barred', 'gates.lifted'])
    }
  })
})

describe('a global lift whose announcements failed partway', () => {
  test('reports the failure, and retrying the lift finishes them with no duplicates', async () => {
    const w = world(20)
    const actor = { guildId: w.guilds[0] ?? '', memberId: OPERATOR }
    await w.gates.bar(actor, 'global')
    await w.gates.settled()
    w.failAnnounceTo(w.guilds[5] ?? '')
    expect(await w.gates.lift(actor, 'global')).toBe(true)
    await w.gates.settled()
    expect(w.announceErrors).toHaveLength(1)
    expect(w.events.get(w.guilds[5] ?? '')).toEqual(['gates.barred'])
    w.failAnnounceTo(null)
    expect(await w.gates.lift(actor, 'global')).toBe(false)
    await w.gates.settled()
    for (const g of w.guilds) {
      expect(w.events.get(g)).toEqual(['gates.barred', 'gates.lifted'])
    }
    expect(await w.gates.lift(actor, 'global')).toBe(false)
    await w.gates.settled()
    for (const g of w.guilds) {
      expect(w.events.get(g)).toEqual(['gates.barred', 'gates.lifted'])
    }
  })
})

describe('a guild bar', () => {
  test('revokes only that guild and tells no other chain', async () => {
    const w = world(3)
    const [a, b] = w.guilds
    await w.gates.bar({ guildId: a ?? '', memberId: OPERATOR }, 'guild')
    expect(w.calls).toEqual(['kill', 'revokeGuildRuns'])
    expect(w.events.get(b ?? '')).toBeUndefined()
  })
})

describe('a sandbox kill that fails', () => {
  test('the bar still commits and the run tokens are still revoked, and the failure is reported', async () => {
    const store = new MemoryGateStore()
    let revoked = 0
    const gates = new Gates({
      store,
      runs: {
        revokeGuildRuns: async () => {
          revoked += 1
          return 4
        },
        revokeAllRuns: async () => 0,
      },
      quests: { releaseLeases: async () => 0, releaseAllLeases: async () => 0 },
      sandboxes: {
        kill: async () => {
          throw new Error('docker unreachable')
        },
      },
      guildIds: async () => [],
    })
    const guildId = crypto.randomUUID()
    const outcome = await gates.bar({ guildId, memberId: OPERATOR }, 'guild')
    expect(outcome.created).toBe(true)
    expect(outcome.revokedRuns).toBe(4)
    expect(outcome.killedSandboxes).toBe(0)
    expect(outcome.killFailed).toBe(true)
    expect(revoked).toBe(1)
    expect(await store.isBarred(guildId)).toBe(true)
  })
})

describe('barring frees the leases of active Quests', () => {
  function gatesReleasing(released: string[], all: string[]) {
    return new Gates({
      store: new MemoryGateStore(),
      runs: { revokeGuildRuns: async () => 0, revokeAllRuns: async () => 0 },
      sandboxes: { kill: async () => 0 },
      quests: {
        releaseLeases: async (guildId, reason) => {
          expect(reason).toBe('sandbox_unavailable')
          released.push(guildId)
          return 1
        },
        releaseAllLeases: async (reason) => {
          expect(reason).toBe('sandbox_unavailable')
          all.push('all')
          return 5
        },
      },
      guildIds: async () => [],
    })
  }

  test('barring one guild releases that guild only', async () => {
    const released: string[] = []
    const all: string[] = []
    const guild = crypto.randomUUID()
    await gatesReleasing(released, all).bar(
      { guildId: guild, memberId: crypto.randomUUID() },
      'guild'
    )
    expect(released).toEqual([guild])
    expect(all).toEqual([])
  })

  test('a global bar releases every guild in one call, not guild by guild', async () => {
    const released: string[] = []
    const all: string[] = []
    await gatesReleasing(released, all).bar(
      { guildId: crypto.randomUUID(), memberId: crypto.randomUUID() },
      'global'
    )
    expect(all).toEqual(['all'])
    expect(released).toEqual([])
  })
})
