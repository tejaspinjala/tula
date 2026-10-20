/** What a sandbox runs for: ids only, never content. */
export interface SandboxSpec {
  questId: string
  /** The id the caller wants the sandbox to have, so it can stop that exact sandbox even if `start` never returns. */
  sandboxId?: string | undefined
  /** The per-run model gateway token. The only credential a sandbox gets; never a provider key. */
  runToken?: string
  /** Opaque handle the worker exchanges for its Quest lease at the MCP gateway. */
  leaseHandle?: string
  /** The Quest's done-condition: public template text, not a secret. */
  doneCondition?: string
}

/** A running sandbox. */
export interface Sandbox {
  sandboxId: string
  guildId: string
  questId: string
}

/**
 * What to kill: every sandbox of every guild, of one guild, (with `questId`) of one Quest of a guild,
 * or (with `sandboxId`) exactly one sandbox, so a late start can stop its own container and no other.
 */
export type KillTarget = { guildId: string; questId?: string; sandboxId?: string } | 'all'

/**
 * Port for the isolated worker that runs a Quest's code. The Docker adapter runs each sandbox hardened
 * behind the egress proxy; the memory adapter stands in for tests. `kill` is the last step of Bar the Gates and
 * must be idempotent and safe to repeat.
 */
export interface SandboxRunner {
  /** Starts a sandbox for the guild. */
  start(guildId: string, spec: SandboxSpec): Promise<Sandbox>
  /** Stops the target's sandboxes now; returns how many were running. Killing nothing returns 0. */
  kill(target: KillTarget): Promise<number>
  /** The guild's running sandboxes. */
  list(guildId: string): Promise<Sandbox[]>
}
