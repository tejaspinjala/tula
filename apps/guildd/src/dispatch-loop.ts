import { type Dispatcher, dispatchAll } from './dispatch'

/** How many guild ids one page of the sweep reads. */
const GUILD_PAGE = 100

/** The timer the loop runs on; `setInterval` and `clearInterval` in the server, a manual one in tests. */
export interface LoopTimer<Handle> {
  schedule(fn: () => void, ms: number): Handle
  clear(handle: Handle): void
}

/** Collaborators of {@link startDispatchLoop}. */
export interface DispatchLoopDeps<Handle> {
  /** Absent for a loop that only runs `guildSweeps`. */
  dispatcher?: Pick<Dispatcher, 'dispatch'>
  /** Idempotent per-guild upkeep run after each guild's dispatch (for example reaping stale research slots). */
  guildSweeps?: Array<(guildId: string) => Promise<unknown>>
  /** A page of guild ids after the cursor, ascending. */
  guildIds(after: string | undefined, limit: number): Promise<string[]>
  intervalMs: number
  pageSize?: number
  timer: LoopTimer<Handle>
  /** Told of a failing guild or sweep; the loop carries on. */
  onError(error: unknown, guildId?: string): void
}

/** A running dispatch loop. */
export interface DispatchLoop {
  /** Resolves once the pass in flight, if any, has finished. */
  idle(): Promise<void>
  /** Stops scheduling and waits for the pass in flight. */
  stop(): Promise<void>
}

/**
 * Runs {@link dispatchAll} over every guild on a fixed interval. A plain interval is enough here:
 * no durable state lives in the loop (the Quest queue and Seals are the state, and `dispatch` is
 * idempotent), so a restart or a second process loses and duplicates nothing. A tick that finds
 * the previous pass still running is skipped. The caller stops it on shutdown.
 */
export function startDispatchLoop<Handle>(deps: DispatchLoopDeps<Handle>): DispatchLoop {
  let running: Promise<void> | null = null
  const sweep = async (): Promise<void> => {
    let after: string | undefined
    for (;;) {
      const page = await deps.guildIds(after, deps.pageSize ?? GUILD_PAGE)
      const dispatcher = deps.dispatcher ?? {
        dispatch: async (): Promise<never> => {
          throw new Error('no dispatcher')
        },
      }
      for (const result of await dispatchAll(dispatcher, page)) {
        if ('error' in result) {
          deps.onError(result.error, result.guildId)
        }
      }
      for (const guildId of page) {
        for (const guildSweep of deps.guildSweeps ?? []) {
          try {
            await guildSweep(guildId)
          } catch (error) {
            deps.onError(error, guildId)
          }
        }
      }
      const last = page.at(-1)
      if (last === undefined || page.length < (deps.pageSize ?? GUILD_PAGE)) {
        return
      }
      after = last
    }
  }
  const handle = deps.timer.schedule(() => {
    if (running !== null) {
      return
    }
    running = sweep()
      .catch(deps.onError)
      .finally(() => {
        running = null
      })
  }, deps.intervalMs)
  const idle = async () => {
    await running
  }
  return {
    idle,
    async stop() {
      deps.timer.clear(handle)
      await idle()
    },
  }
}
