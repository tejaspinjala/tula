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
  quests: Pick<QuestQueue, 'releaseLeases'>
  /** Guild ids in id order after `after`, at most `limit`; a global bar tells each guild's chain. */
  guildIds: (after: string | undefined, limit: number) => Promise<string[]>
}

/**
 * Bar the Gates: the one deterministic kill path. Barring records the bar (committed, with its
 * chained event), then kills the sandboxes, revokes the run tokens and, for a global bar, tells
 * every guild's chain; no transaction is held across that I/O. The tool, model and queue gates
 * read the {@link GateStore} themselves on every call, so the bar is enforced from the moment it
 * commits, before any revoke or announcement finishes: the stop steps only make the shut gates
 * permanent (tokens never come back) and complete the audit trail. A global bar revokes every
 * token in one statement and announces to at most {@link ANNOUNCE_CONCURRENCY} guilds at a time,
 * well under the connection pool. No model is consulted.
 */
export class Gates {
  constructor(private readonly deps: GatesDeps) {}

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
    const announcing =
      scope === 'global' ? this.announceAll({ type: 'gates.barred', barId }) : Promise.resolve()
    // The killed workers' leases would otherwise linger until they lapse and block a restart after a lift.
    const releasing = this.releaseLeases(scope === 'global' ? null : actor.guildId)
    const [kill, revokedRuns] = await Promise.all([killing, revoking, announcing, releasing])
    return {
      barId,
      created,
      revokedRuns,
      killedSandboxes: kill.killed,
      killFailed: kill.failed,
    }
  }

  /** Releases the active Quests' leases of one guild, or of every guild a page at a time. */
  private async releaseLeases(guildId: string | null): Promise<void> {
    if (guildId !== null) {
      await this.deps.quests.releaseLeases(guildId, 'sandbox_unavailable')
      return
    }
    let after: string | undefined
    for (;;) {
      const page = await this.deps.guildIds(after, GUILD_PAGE)
      for (let i = 0; i < page.length; i += ANNOUNCE_CONCURRENCY) {
        await Promise.all(
          page
            .slice(i, i + ANNOUNCE_CONCURRENCY)
            .map((g) => this.deps.quests.releaseLeases(g, 'sandbox_unavailable'))
        )
      }
      const last = page.at(-1)
      if (!last || page.length < GUILD_PAGE) {
        return
      }
      after = last
    }
  }

  /** Tells every guild's chain about a global bar or lift, a page at a time, a few guilds at once. */
  private async announceAll(event: GlobalEvent): Promise<void> {
    let after: string | undefined
    for (;;) {
      const page = await this.deps.guildIds(after, GUILD_PAGE)
      for (let i = 0; i < page.length; i += ANNOUNCE_CONCURRENCY) {
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
          await this.announceAll({ type: 'gates.lifted', barId: pending })
        }
      }
      return false
    }
    if (scope === 'global') {
      await this.announceAll({ type: 'gates.lifted', barId })
    }
    return true
  }

  /** Which bars are up for the guild. */
  status(guildId: string): Promise<GateStatus> {
    return this.deps.store.status(guildId)
  }
}
