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
  let widest = 0
  const observe = async () => {
    barredAt.push(await slowStore.isBarred(guilds[0] ?? ''))
  }
  // Announcements are slow on purpose, so unbounded concurrency would show.
  class SlowStore extends MemoryGateStore {
    override async announceGlobal(guildId: string, event: GlobalEvent): Promise<boolean> {
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
    sandboxes: {
      kill: async () => {
        calls.push('kill')
        await observe()
        return 3
      },
    },
    guildIds: async (after, limit) =>
      guilds.filter((g) => after === undefined || g > after).slice(0, limit),
  })
  return { guilds, gates, events, calls, barredAt, widest: () => widest }
}

describe('a global bar over many guilds', () => {
  test('starts the kill first, revokes every token in one call and keeps the gates shut throughout', async () => {
    const w = world(MANY)
    const out = await w.gates.bar({ guildId: w.guilds[0] ?? '', memberId: OPERATOR }, 'global')
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
    expect(await w.gates.lift(actor, 'global')).toBe(true)
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
