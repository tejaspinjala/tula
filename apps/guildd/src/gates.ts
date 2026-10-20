import type { GateActor, GateScope, GateStatus, GateStore } from './ports/gate-store'
import type { SandboxRunner } from './ports/sandbox-runner'

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
  /** Revokes every run token of a guild for good; the model gateway. */
  runs: { revokeGuildRuns(guildId: string): Promise<number> }
  sandboxes: Pick<SandboxRunner, 'kill'>
  /** Guild ids in id order after `after`, at most `limit`; a global bar revokes every guild's tokens. */
  guildIds: (after: string | undefined, limit: number) => Promise<string[]>
}

/**
 * Bar the Gates: the one deterministic kill path. Barring records the bar (committed, with its
 * chained event), then revokes every run token and kills the sandboxes; no transaction is held
 * across that I/O. The tool, model and queue gates read the {@link GateStore} themselves on every
 * call, so the bar holds from the moment it commits. No model is consulted.
 */
export class Gates {
  constructor(private readonly deps: GatesDeps) {}

  /** Bars one guild or all; immediate, idempotent, and always (re)runs the stop steps. */
  async bar(actor: GateActor, scope: GateScope): Promise<BarOutcome> {
    const { barId, created } = await this.deps.store.bar(actor, scope)
    return { barId, created, revokedRuns: 0, killedSandboxes: 0 }
  }

  /** Lifts the bar; false when it was not up. Revoked run tokens stay revoked. */
  lift(actor: GateActor, scope: GateScope): Promise<boolean> {
    return this.deps.store.lift(actor, scope)
  }

  /** Which bars are up for the guild. */
  status(guildId: string): Promise<GateStatus> {
    return this.deps.store.status(guildId)
  }
}
