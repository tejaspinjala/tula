/** What a bar covers: one guild, or every guild. */
export type GateScope = 'guild' | 'global'

/** Who bars or lifts: the acting Guild Master, in the guild whose chain records the event. */
export interface GateActor {
  guildId: string
  memberId: string
}

/** Which bars are up for one guild. */
export interface GateStatus {
  /** This guild is barred. */
  guild: boolean
  /** Every guild is barred. */
  global: boolean
}

/**
 * Port for Bar the Gates, the kill switch. A guild has at most one bar and there is at most one
 * global bar; barring is immediate and idempotent, lifting removes it. Each change appends a
 * chained event with ids only (`gates.barred`, `gates.lifted`) to the acting guild's chain. Who may
 * bar or lift is decided by the route, never here; stopping runs and sandboxes is {@link Gates}'s job.
 * The checks read the store on every call and cache nothing.
 */
export interface GateStore {
  /** Bars; if already barred, returns the existing bar with `created: false` and no event. */
  bar(actor: GateActor, scope: GateScope): Promise<{ barId: string; created: boolean }>
  /** Lifts; false (and no event) when no such bar was up. */
  lift(actor: GateActor, scope: GateScope): Promise<boolean>
  /** Whether the guild is barred now, by its own bar or the global one. */
  isBarred(guildId: string): Promise<boolean>
  /** Which bars are up for the guild. */
  status(guildId: string): Promise<GateStatus>
}
