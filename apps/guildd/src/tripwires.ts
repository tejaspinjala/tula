import { guildTripwires, type TripwireThresholds } from './guild-config'
import type { ConfigStore } from './ports/config-store'
import type { ModelLedger } from './ports/model-ledger'
import type { HallPause, TripwireKind, TripwireStore } from './ports/tripwire-store'

/** What the platform measured for one Hall; numbers only, supplied by the usage meter. */
export interface HallUsage {
  /** Tokens the Hall has used today. */
  tokensToday: number
  /** Tokens used on each of the previous 7 days (the baseline is their median). */
  tokensPerDay7d: readonly number[]
  /** Gate denials charged to the Hall in the last hour. */
  gateDenialsLastHour: number
  /** The most times one action (by fingerprint) repeated in the Hall's recent runs. */
  maxActionRepeats: number
}

/** A Tripwire that tripped, with what it saw and the line it crossed. */
export interface Trip {
  tripwire: Exclude<TripwireKind, 'manual'>
  observed: number
  threshold: number
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length === 0) {
    return 0
  }
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * Evaluates the Tripwires over one Hall's usage and returns the first that tripped, or null.
 * Pure and deterministic, never a model decision. Token burn trips strictly above
 * `tokenBurnMultiple` times the 7-day median (and never without a baseline); denials and loops
 * trip on reaching their limit.
 */
export function evaluateTripwires(thresholds: TripwireThresholds, usage: HallUsage): Trip | null {
  const baseline = median(usage.tokensPerDay7d)
  const burnLimit = baseline * thresholds.tokenBurnMultiple
  if (baseline > 0 && usage.tokensToday > burnLimit) {
    return { tripwire: 'token_burn', observed: usage.tokensToday, threshold: burnLimit }
  }
  if (usage.gateDenialsLastHour >= thresholds.gateDenialsPerHour) {
    return {
      tripwire: 'gate_denials',
      observed: usage.gateDenialsLastHour,
      threshold: thresholds.gateDenialsPerHour,
    }
  }
  if (usage.maxActionRepeats >= thresholds.loopRepeats) {
    return { tripwire: 'loop', observed: usage.maxActionRepeats, threshold: thresholds.loopRepeats }
  }
  return null
}

/** The outcome of {@link runTripwires}. */
export type TripwireRun =
  | { paused: false }
  | { paused: true; pause: HallPause; created: boolean; trip: Trip }

/**
 * Evaluates the Hall's usage against the guild's configured thresholds and, if a Tripwire
 * trips, pauses the Hall at once (idempotent; an already paused Hall keeps its first pause) and revokes
 * the Hall's live run tokens.
 */
export async function runTripwires(
  deps: {
    config: ConfigStore
    tripwires: TripwireStore
    /** Revokes the paused Hall's live run tokens. */
    runs: Pick<ModelLedger, 'revokeHallRuns'>
  },
  guildId: string,
  hallId: string,
  usage: HallUsage
): Promise<TripwireRun> {
  const { config } = await deps.config.current(guildId)
  const trip = evaluateTripwires(guildTripwires(config), usage)
  if (!trip) {
    return { paused: false }
  }
  const { pause, created } = await deps.tripwires.pause(guildId, { hallId, ...trip })
  await deps.runs.revokeHallRuns(guildId, hallId)
  return { paused: true, pause, created, trip }
}
