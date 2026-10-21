import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { ModelLedger } from './ports/model-ledger'
import type { QuestQueue } from './ports/quest-queue'
import type { SealStore } from './ports/seal-store'
import type { TripwireStore } from './ports/tripwire-store'
import type { ProposalEngine } from './proposals'
import { type HallUsage, runTripwires } from './tripwires'

/** Collaborators of {@link watchHalls}. */
export interface HallWatchDeps {
  config: Pick<ConfigStore, 'current'>
  tripwires: TripwireStore
  ledger: Pick<ModelLedger, 'hallDayTotals' | 'revokeHallRuns'>
  quests: Pick<QuestQueue, 'list' | 'get'>
  sealStore: Pick<SealStore, 'list'>
  proposals: Pick<ProposalEngine, 'listFailedSince'>
  clock: Clock
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const PAGE = 100

function day(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/** A Hall's tokens used today and on each of the previous seven days (oldest first; zero for a day with no usage). */
async function hallTokens(
  ledger: Pick<ModelLedger, 'hallDayTotals'>,
  guildId: string,
  hallId: string,
  now: Date
): Promise<{ today: number; perDay7d: number[] }> {
  const days = Array.from({ length: 7 }, (_, i) => day(new Date(now.getTime() - (7 - i) * DAY_MS)))
  const rows = await ledger.hallDayTotals(guildId, hallId, {
    from: days[0] ?? day(now),
    to: day(now),
  })
  const tokens = new Map(rows.map((r) => [r.day, r.tokens]))
  return { today: tokens.get(day(now)) ?? 0, perDay7d: days.map((d) => tokens.get(d) ?? 0) }
}

/** Counts one denial against the Hall of `questId`, looking each Quest's Hall up once. */
async function charge(
  quests: Pick<QuestQueue, 'get'>,
  guildId: string,
  questId: string,
  hallOf: Map<string, string | null>,
  denials: Map<string, number>
): Promise<void> {
  if (!hallOf.has(questId)) {
    hallOf.set(questId, (await quests.get(guildId, questId))?.hallId ?? null)
  }
  const hallId = hallOf.get(questId)
  if (hallId) {
    denials.set(hallId, (denials.get(hallId) ?? 0) + 1)
  }
}

/**
 * How many gate denials each Hall had in the last hour: its Seals denied and its Proposals whose
 * Verdict failed (a failed Verdict leaves no Seal, so it is counted from the Proposal). Both are
 * indexed range reads by time, so the cost follows the last hour, not the guild's history.
 */
async function denialsLastHour(
  deps: Pick<HallWatchDeps, 'quests' | 'sealStore' | 'proposals'>,
  guildId: string,
  now: Date
): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - HOUR_MS).toISOString()
  const denials = new Map<string, number>()
  const hallOf = new Map<string, string | null>()
  let after: string | undefined
  do {
    const page = await deps.sealStore.list(guildId, {
      limit: PAGE,
      status: 'denied',
      decidedSince: since,
      ...(after ? { after } : {}),
    })
    for (const seal of page.seals) {
      await charge(deps.quests, guildId, seal.questId, hallOf, denials)
    }
    after = page.next ?? undefined
  } while (after !== undefined)
  do {
    const page = await deps.proposals.listFailedSince(guildId, since, {
      limit: PAGE,
      ...(after ? { after } : {}),
    })
    for (const proposal of page.proposals) {
      await charge(deps.quests, guildId, proposal.questId, hallOf, denials)
    }
    after = page.next ?? undefined
  } while (after !== undefined)
  return denials
}

/** The most attempts spent on one Quest still being retried, per Hall. */
async function attemptsPerHall(
  quests: Pick<QuestQueue, 'list'>,
  guildId: string
): Promise<Map<string, number>> {
  const repeats = new Map<string, number>()
  for (const state of ['queued', 'active'] as const) {
    let after: string | undefined
    do {
      const page = await quests.list(guildId, {
        limit: PAGE,
        state,
        ...(after ? { after } : {}),
      })
      for (const quest of page.quests) {
        // Claims given back (a wait, a bar, a park) are not loop repeats: only real attempts count.
        const real = quest.attempts - quest.refunds
        repeats.set(quest.hallId, Math.max(repeats.get(quest.hallId) ?? 0, real))
      }
      after = page.next ?? undefined
    } while (after !== undefined)
  }
  return repeats
}

/**
 * Feeds the Tripwires of every Hall of the guild from what the platform measured, so token burn,
 * gate denials and loops pause a Hall in the real loop. Deterministic code; a paused Hall takes
 * no further claims (`QuestQueue.claim` skips it). Measures:
 *
 * - `tokensToday` and the 7-day baseline: the Hall's own metered usage from the ModelLedger, so a
 *   burn pauses only the Hall that burned;
 * - `gateDenialsLastHour`: the Hall's Seals denied and Proposals whose Verdict failed in the last hour;
 * - `maxActionRepeats`: the most attempts spent on one of the Hall's Quests still being retried.
 *   This is an approximation, kept on purpose: the platform records no per-action fingerprint (a
 *   run's tool calls are not logged by action), so the retry count of a queued or active Quest is
 *   the only repeat signal there is. It never under-counts a Quest that keeps failing and being
 *   re-claimed, which is the loop a Hall can fall into.
 *
 * Returns the ids of the Halls it paused in this pass.
 */
export async function watchHalls(deps: HallWatchDeps, guildId: string): Promise<string[]> {
  const now = deps.clock.now()
  const { config } = await deps.config.current(guildId)
  const denials = await denialsLastHour(deps, guildId, now)
  const repeats = await attemptsPerHall(deps.quests, guildId)
  const paused: string[] = []
  for (const hall of config.halls) {
    const tokens = await hallTokens(deps.ledger, guildId, hall.id, now)
    const usage: HallUsage = {
      tokensToday: tokens.today,
      tokensPerDay7d: tokens.perDay7d,
      gateDenialsLastHour: denials.get(hall.id) ?? 0,
      maxActionRepeats: repeats.get(hall.id) ?? 0,
    }
    const run = await runTripwires(
      { config: deps.config, tripwires: deps.tripwires, runs: deps.ledger },
      guildId,
      hall.id,
      usage
    )
    if (run.paused && run.created) {
      paused.push(hall.id)
    }
  }
  return paused
}
