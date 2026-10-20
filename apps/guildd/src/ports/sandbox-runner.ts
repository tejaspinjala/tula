/** What a sandbox runs for: ids only, never content. */
export interface SandboxSpec {
  questId: string
}

/** A running sandbox. */
export interface Sandbox {
  sandboxId: string
  guildId: string
  questId: string
}

/** What to kill: every sandbox of one guild, or every sandbox of every guild. */
export type KillTarget = { guildId: string } | 'all'

/**
 * Port for the isolated worker that runs a Quest's code. The Docker adapter arrives with the real
 * worker; the memory adapter stands in until then. `kill` is the last step of Bar the Gates and
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
