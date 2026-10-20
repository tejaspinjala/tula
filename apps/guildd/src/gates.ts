import type { GateActor, GateScope, GateStatus, GateStore, GlobalEvent } from './ports/gate-store'
import type { QuestQueue } from './ports/quest-queue'
import type { SandboxRunner } from './ports/sandbox-runner'

const GUILD_PAGE = 50
/** Guilds told at once; far below the pool size, so a global bar cannot starve the routes. */
const ANNOUNCE_CONCURRENCY = 8

/** What barring did: the bar, and how much running work it stopped. */
export interface BarOutcome {
  barId: string
  /** False when the bar was already up (the stop steps still ran, so a retry finishes a partial bar). */
  created: boolean
  /** Run tokens revoked. */
  revokedRuns: number
  /** Sandboxes killed. */
  killedSandboxes: number
  /** True when the sandbox kill itself failed; the bar and the revoked tokens stand, and a retry kills again. */
  killFailed: boolean
}

/** Ports {@link Gates} is built from. */
export interface GatesDeps {
  store: GateStore
  /** Revokes run tokens for good (one guild, or every guild in one statement); the model gateway. */
  runs: {
    revokeGuildRuns(guildId: string): Promise<number>
    revokeAllRuns(): Promise<number>
  }
  sandboxes: Pick<SandboxRunner, 'kill'>
  /** Frees the leases of a barred guild's active Quests, so a lift can start them again. */
  quests: Pick<QuestQueue, 'releaseLeases' | 'releaseAllLeases'>
  /** Guild ids in id order after `after`, at most `limit`; a global bar tells each guild's chain. */
  guildIds: (after: string | undefined, limit: number) => Promise<string[]>
  /** Told when the announcements that follow a global bar fail; they stay re-runnable. Defaults to a structured line on stderr. */
  onAnnounceError?: (error: unknown) => void
}

/**
 * Bar the Gates: the one deterministic kill path. Barring records the bar (committed, with its
 * chained event), then kills the sandboxes, revokes the run tokens and, for a global bar, tells
 * every guild's chain; no transaction is held across that I/O. The tool, model and queue gates
 * read the {@link GateStore} themselves on every call, so the bar is enforced from the moment it
 * commits, before any revoke or announcement finishes: the stop steps only make the shut gates
 * permanent (tokens never come back) and complete the audit trail. A global bar revokes every
 * token and releases every lease in one statement each, so its response time does not grow with
 * the number of guilds. Telling the guild chains is O(guilds), so it runs after the response, in
 * the background (a lift's announcements too): one promise at a time (a repeat while it runs reuses
 * it, so there is no queue), at most {@link ANNOUNCE_CONCURRENCY} guilds at once in pages of {@link GUILD_PAGE}.
 * A failure is reported to `onAnnounceError` and never lost: announcements are idempotent per
 * guild and bar, and a repeated bar or any lift finishes them. {@link settled} resolves when the
 * background run ends (tests and graceful shutdown). No model is consulted.
 */
export class Gates {
  /** The one in-flight background announcement of a global bar, if any. */
  private announcing: { key: string; done: Promise<void> } | null = null

  /** Set by {@link stop}: background announcements end at their next page boundary. */
  private stopped = false

  constructor(private readonly deps: GatesDeps) {}

  /**
   * Ends the background announcement at its next batch and waits for it, for a graceful shutdown.
   * What it left untold stays untold: a repeated bar or any lift finishes it.
   */
  async stop(): Promise<void> {
    this.stopped = true
    await this.settled()
  }

  /** Resolves once the background announcement of a global bar, if one is running, has ended (never rejects). */
  async settled(): Promise<void> {
    await this.announcing?.done
  }

  /** Bars one guild or all; immediate, idempotent, and always (re)runs the stop steps. */
  async bar(actor: GateActor, scope: GateScope): Promise<BarOutcome> {
    const { barId, created } = await this.deps.store.bar(actor, scope)
    // The kill starts first: a running sandbox is the slowest thing to stop.
    // A kill that fails must not stop the revokes and announcements: the bar is already committed.
    const killing = this.deps.sandboxes
      .kill(scope === 'global' ? 'all' : { guildId: actor.guildId })
      .then(
        (killed) => ({ killed, failed: false }),
        () => ({ killed: 0, failed: true })
      )
    const revoking =
      scope === 'global'
        ? this.deps.runs.revokeAllRuns()
        : this.deps.runs.revokeGuildRuns(actor.guildId)
    // The killed workers' leases would otherwise linger until they lapse and block a restart after a lift.
    const releasing =
      scope === 'global'
        ? this.deps.quests.releaseAllLeases('sandbox_unavailable')
        : this.deps.quests.releaseLeases(actor.guildId, 'sandbox_unavailable')
    const [kill, revokedRuns] = await Promise.all([killing, revoking, releasing])
    if (scope === 'global') {
      this.announceInBackground(barId, false)
    }
    return {
      barId,
      created,
      revokedRuns,
      killedSandboxes: kill.killed,
      killFailed: kill.failed,
    }
  }

  /**
   * Starts telling every guild's chain about a global bar (and, once lifted, the lift) after the
   * response; never rejects. A repeat of what is already the latest run reuses it, and a run waits
   * for the one before it, so a guild's chain never gets the lift ahead of the bar. At most one run
   * is active; the chain is as long as the operator's alternating bars and lifts, never the guild count.
   */
  private announceInBackground(barId: string, lifted: boolean): void {
    const key = `${barId}:${lifted}`
    if (this.announcing?.key === key) {
      return
    }
    const report =
      this.deps.onAnnounceError ??
      (() => {
        // Ids only: no error text can carry content to the log.
        process.stderr.write(`${JSON.stringify({ event: 'gates.announce_failed', barId })}\n`)
      })
    const previous = this.announcing?.done ?? Promise.resolve()
    const done: Promise<void> = previous
      .then(async () => {
        // Also finishes a bar announcement that failed earlier (idempotent per guild and bar).
        await this.announceAll({ type: 'gates.barred', barId })
        if (lifted) {
          await this.announceAll({ type: 'gates.lifted', barId })
        }
      })
      .catch(report)
      .finally(() => {
        if (this.announcing?.done === done) {
          this.announcing = null
        }
      })
    this.announcing = { key, done }
  }

  /** Tells every guild's chain about a global bar or lift, a page at a time, a few guilds at once. */
  private async announceAll(event: GlobalEvent): Promise<void> {
    let after: string | undefined
    for (;;) {
      const page = await this.deps.guildIds(after, GUILD_PAGE)
      for (let i = 0; i < page.length; i += ANNOUNCE_CONCURRENCY) {
        if (this.stopped) {
          return
        }
        await Promise.all(
          page
            .slice(i, i + ANNOUNCE_CONCURRENCY)
            .map((g) => this.deps.store.announceGlobal(g, event))
        )
      }
      const last = page.at(-1)
      if (!last || page.length < GUILD_PAGE) {
        return
      }
      after = last
    }
  }

  /**
   * Lifts the bar; false when it was not up. Revoked run tokens stay revoked. Retrying a global
   * lift that failed partway finishes its announcements (and still returns false).
   */
  async lift(actor: GateActor, scope: GateScope): Promise<boolean> {
    const barId = await this.deps.store.lift(actor, scope)
    if (barId === null) {
      // Nothing to lift now. A global lift that failed partway left its announcements unfinished;
      // finish them for the latest lift in this guild's chain (idempotent per guild).
      if (scope === 'global') {
        const pending = await this.deps.store.latestGlobalLift(actor.guildId)
        if (pending !== null) {
          this.announceInBackground(pending, true)
        }
      }
      return false
    }
    if (scope === 'global') {
      this.announceInBackground(barId, true)
    }
    return true
  }

  /** Which bars are up for the guild. */
  status(guildId: string): Promise<GateStatus> {
    return this.deps.store.status(guildId)
  }
}
