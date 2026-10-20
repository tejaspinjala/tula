import { describe, expect, test } from 'bun:test'
import { startDispatchLoop } from './dispatch-loop'

/** A manual timer: `tick()` fires the scheduled callback the way setInterval would. */
function manualTimer() {
  let callback: (() => void) | null = null
  let cleared = 0
  return {
    schedule: (fn: () => void, _ms: number) => {
      callback = fn
      return 1
    },
    clear: (_handle: number) => {
      callback = null
      cleared += 1
    },
    tick: () => callback?.(),
    get cleared() {
      return cleared
    },
  }
}

const guilds = async (after: string | undefined, limit: number) =>
  ['a', 'b', 'c'].filter((g) => after === undefined || g > after).slice(0, limit)

describe('startDispatchLoop', () => {
  test('each tick runs one pass for every guild, a page at a time', async () => {
    const seen: string[] = []
    const timer = manualTimer()
    const loop = startDispatchLoop({
      dispatcher: {
        dispatch: async (g) => {
          seen.push(g)
          return { status: 'idle' }
        },
      },
      guildIds: guilds,
      intervalMs: 1000,
      pageSize: 2,
      timer,
      onError: () => {},
    })
    timer.tick()
    await loop.idle()
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  test('a tick that finds the previous pass still running is skipped', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let passes = 0
    const timer = manualTimer()
    const loop = startDispatchLoop({
      dispatcher: {
        dispatch: async () => {
          passes += 1
          await gate
          return { status: 'idle' }
        },
      },
      guildIds: async (after) => (after === undefined ? ['a'] : []),
      intervalMs: 1000,
      timer,
      onError: () => {},
    })
    timer.tick()
    timer.tick()
    release()
    await loop.idle()
    expect(passes).toBe(1)
  })

  test('a failing guild is reported and the rest still run', async () => {
    const errors: unknown[] = []
    const seen: string[] = []
    const timer = manualTimer()
    const loop = startDispatchLoop({
      dispatcher: {
        dispatch: async (g) => {
          seen.push(g)
          if (g === 'b') {
            throw new Error('boom')
          }
          return { status: 'idle' }
        },
      },
      guildIds: guilds,
      intervalMs: 1000,
      timer,
      onError: (e) => errors.push(e),
    })
    timer.tick()
    await loop.idle()
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(errors).toHaveLength(1)
  })

  test('stop clears the timer and waits for a pass in flight', async () => {
    const timer = manualTimer()
    const loop = startDispatchLoop({
      dispatcher: { dispatch: async () => ({ status: 'idle' }) },
      guildIds: guilds,
      intervalMs: 1000,
      timer,
      onError: () => {},
    })
    timer.tick()
    await loop.stop()
    expect(timer.cleared).toBe(1)
    timer.tick()
    await loop.idle()
  })

  test('a loop with no dispatcher only runs its guild sweeps and reports no error', async () => {
    const swept: string[] = []
    const errors: unknown[] = []
    const timer = manualTimer()
    const loop = startDispatchLoop({
      guildSweeps: [async (g) => void swept.push(g)],
      guildIds: guilds,
      intervalMs: 1000,
      timer,
      onError: (e) => void errors.push(e),
    })
    timer.tick()
    await loop.idle()
    expect(swept).toEqual(['a', 'b', 'c'])
    expect(errors).toEqual([])
  })

  test('each tick also runs every guild sweep, and a failing sweep is reported, not fatal', async () => {
    const swept: string[] = []
    const errors: string[] = []
    const timer = manualTimer()
    const loop = startDispatchLoop({
      dispatcher: { dispatch: async () => ({ status: 'idle' }) },
      guildSweeps: [
        async (g) => {
          if (g === 'b') {
            throw new Error('boom')
          }
          swept.push(g)
        },
      ],
      guildIds: guilds,
      intervalMs: 1000,
      timer,
      onError: (_e, g) => void errors.push(g ?? 'all'),
    })
    timer.tick()
    await loop.idle()
    expect(swept).toEqual(['a', 'c'])
    expect(errors).toEqual(['b'])
  })
})
