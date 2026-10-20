import type { GateActor, GateScope, GateStatus, GateStore, GlobalEvent } from './ports/gate-store'
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
    const killing = this.deps.sandboxes.kill(
      scope === 'global' ? 'all' : { guildId: actor.guildId }
    )
    const revoking =
      scope === 'global'
        ? this.deps.runs.revokeAllRuns()
        : this.deps.runs.revokeGuildRuns(actor.guildId)
    const announcing =
      scope === 'global'
        ? this.announceAll({ type: 'gates.barred', barId, memberId: actor.memberId })
        : Promise.resolve()
    const [killedSandboxes, revokedRuns] = await Promise.all([killing, revoking, announcing])
    return { barId, created, revokedRuns, killedSandboxes }
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

  /** Lifts the bar; false when it was not up. Revoked run tokens stay revoked. */
  async lift(actor: GateActor, scope: GateScope): Promise<boolean> {
    const barId = await this.deps.store.lift(actor, scope)
    if (barId === null) {
      return false
    }
    if (scope === 'global') {
      await this.announceAll({ type: 'gates.lifted', barId, memberId: actor.memberId })
    }
    return true
  }

  /** Which bars are up for the guild. */
  status(guildId: string): Promise<GateStatus> {
    return this.deps.store.status(guildId)
  }
}
