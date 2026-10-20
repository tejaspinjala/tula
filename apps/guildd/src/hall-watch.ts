import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { ModelLedger } from './ports/model-ledger'
import type { QuestQueue } from './ports/quest-queue'
import type { SealStore } from './ports/seal-store'
import type { TripwireStore } from './ports/tripwire-store'
import { type HallUsage, runTripwires } from './tripwires'

/** Collaborators of {@link watchHalls}. */
export interface HallWatchDeps {
  config: Pick<ConfigStore, 'current'>
  tripwires: TripwireStore
  ledger: Pick<ModelLedger, 'dayTotals' | 'report' | 'revokeHallRuns'>
  quests: Pick<QuestQueue, 'list' | 'get'>
  sealStore: Pick<SealStore, 'list'>
  clock: Clock
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const PAGE = 100

function day(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/** The previous seven days' token totals, oldest first; a day with no usage counts as zero. */
async function tokensPerDay7d(
  ledger: Pick<ModelLedger, 'report'>,
  guildId: string,
  now: Date
): Promise<number[]> {
  const days = Array.from({ length: 7 }, (_, i) => day(new Date(now.getTime() - (7 - i) * DAY_MS)))
  const tokens = new Map<string, number>()
  let after: string | undefined
  do {
    const page = await ledger.report(guildId, 'day', { limit: PAGE, ...(after ? { after } : {}) })
    for (const row of page.rows) {
      tokens.set(row.key, row.inputTokens + row.outputTokens)
    }
    after = page.next ?? undefined
  } while (after !== undefined)
  return days.map((d) => tokens.get(d) ?? 0)
}

/** How many Seals of each Hall were denied in the last hour. */
async function denialsLastHour(
  deps: Pick<HallWatchDeps, 'quests' | 'sealStore'>,
  guildId: string,
  now: Date
): Promise<Map<string, number>> {
  const denials = new Map<string, number>()
  const hallOf = new Map<string, string | null>()
  let after: string | undefined
  do {
    const page = await deps.sealStore.list(guildId, {
      limit: PAGE,
      status: 'denied',
      ...(after ? { after } : {}),
    })
    for (const seal of page.seals) {
      if (!seal.decidedAt || now.getTime() - Date.parse(seal.decidedAt) > HOUR_MS) {
        continue
      }
      if (!hallOf.has(seal.questId)) {
        hallOf.set(seal.questId, (await deps.quests.get(guildId, seal.questId))?.hallId ?? null)
      }
      const hallId = hallOf.get(seal.questId)
      if (hallId) {
        denials.set(hallId, (denials.get(hallId) ?? 0) + 1)
      }
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
        repeats.set(quest.hallId, Math.max(repeats.get(quest.hallId) ?? 0, quest.attempts))
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
 * - `tokensToday` and the 7-day baseline: the guild's metered usage from the ModelLedger (the
 *   ledger cannot split a day by Hall, so a burn is judged guild-wide and applies to every Hall);
 * - `gateDenialsLastHour`: the Hall's Seals denied in the last hour;
 * - `maxActionRepeats`: the most attempts spent on one of the Hall's Quests still being retried.
 *
 * Returns the ids of the Halls it paused in this pass.
 */
export async function watchHalls(deps: HallWatchDeps, guildId: string): Promise<string[]> {
  const now = deps.clock.now()
  const { config } = await deps.config.current(guildId)
  const totals = await deps.ledger.dayTotals(guildId, day(now))
  const baseline = await tokensPerDay7d(deps.ledger, guildId, now)
  const denials = await denialsLastHour(deps, guildId, now)
  const repeats = await attemptsPerHall(deps.quests, guildId)
  const paused: string[] = []
  for (const hall of config.halls) {
    const usage: HallUsage = {
      tokensToday: totals.tokens,
      tokensPerDay7d: baseline,
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
