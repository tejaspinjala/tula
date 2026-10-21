import type { z } from 'zod'
import { type CrossHallRefusal, resolveCrossHall } from './cross-hall'
import { hallAcceptsQuests } from './guild-config'
import type { BugReport, BugReportStore, fileBugReportInput } from './ports/bug-report-store'
import { reproduction } from './ports/bug-report-store'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { DataClass, Quest } from './ports/quest-queue'
import type { TripwireStore } from './ports/tripwire-store'
import { chooseHallOwner, FIX_QUEST_TEMPLATE } from './quests'

/** Ports the {@link BugReportService} files through. */
export interface BugReportServiceDeps {
  config: Pick<ConfigStore, 'current'>
  store: Pick<BugReportStore, 'file'>
  clock: Clock
  /** Whether a Hall is paused by a Tripwire; a paused Hall takes no new Fix Quest. */
  tripwires: Pick<TripwireStore, 'isPaused'>
}

/** Who files: a Member's leased Quest (charged the cap, judged by the cross-Hall rule) or the Guild Master. */
export type BugReportSource =
  | { kind: 'member'; questId: string; hallId: string; memberId: string; dataClass: DataClass }
  | { kind: 'guild_master' }

/** Why a Bug Report could not be filed. */
export type BugReportRefusal =
  | CrossHallRefusal
  | 'reproduction_required'
  | 'hall_locked'
  | 'hall_has_no_owner'
  | 'bug_report_cap'

/** The outcome of {@link BugReportService.file}. */
export type BugReportOutcome =
  | { ok: true; report: BugReport; fixQuest: Quest | null }
  | { ok: false; error: BugReportRefusal }

/**
 * Files Bug Reports: checks the reproduction, applies the one cross-Hall rule (a Member may also
 * file against its own Hall), builds the Fix Quest from the report and hands both to the store,
 * which posts, de-duplicates, caps and audits them in one transaction. Pure code; no model.
 */
export class BugReportService {
  constructor(private readonly deps: BugReportServiceDeps) {}

  /**
   * Files a report against `input.owningHall`. `reproduction_required` when any of steps, expected
   * or actual is missing or blank. A Member's filing is judged by the cross-Hall rule
   * (`unknown_hall`, `private_boundary`), the Guild Master's only needs the Hall to exist. The
   * owning Hall must accept Quests (`hall_locked`) and have someone to own the Fix Quest.
   * `bug_report_cap` when a Member's Quest has used its allowance (`maxPerQuest`; the Guild Master
   * has none).
   */
  async file(
    guildId: string,
    input: z.output<typeof fileBugReportInput>,
    source: BugReportSource,
    maxPerQuest?: number
  ): Promise<BugReportOutcome> {
    const repro = reproduction.safeParse(input.reproduction)
    if (!repro.success) {
      return { ok: false, error: 'reproduction_required' }
    }
    const { config } = await this.deps.config.current(guildId)
    const hall = config.halls.find((h) => h.id === input.owningHall)
    if (!hall) {
      return { ok: false, error: 'unknown_hall' }
    }
    if (source.kind === 'member' && source.hallId !== hall.id) {
      const target = resolveCrossHall({
        halls: config.halls,
        sourceHall: source.hallId,
        sourceDataClass: source.dataClass,
        toHall: hall.id,
      })
      if (!target.ok) {
        return { ok: false, error: target.error }
      }
    }
    const accepts = hallAcceptsQuests(config, hall.id)
    if (!accepts.ok) {
      return { ok: false, error: 'hall_locked' }
    }
    const ownerId = chooseHallOwner(config, hall.id, FIX_QUEST_TEMPLATE.rank, undefined)
    if (ownerId === null) {
      return { ok: false, error: 'hall_has_no_owner' }
    }
    const private_ =
      hall.kind === 'private' || (source.kind === 'member' && source.dataClass === 'private')
    const filed = await this.deps.store.file(guildId, {
      owningHall: hall.id,
      title: input.title,
      reproduction: repro.data,
      evidence: input.evidence,
      filer:
        source.kind === 'member'
          ? {
              kind: 'member',
              questId: source.questId,
              hallId: source.hallId,
              memberId: source.memberId,
            }
          : { kind: 'guild_master' },
      fixQuest: {
        jobKey: `bug-report:${crypto.randomUUID()}`,
        templateId: FIX_QUEST_TEMPLATE.id,
        hallId: hall.id,
        rank: FIX_QUEST_TEMPLATE.rank,
        dataClass: private_ ? 'private' : FIX_QUEST_TEMPLATE.dataClass,
        title: `Fix: ${input.title}`,
        ownerId,
        doneCondition: `Fix the defect "${input.title}" so that the reproduction behaves as expected. Steps: ${repro.data.steps} Expected: ${repro.data.expected} Actual: ${repro.data.actual}`,
        roundLimit: FIX_QUEST_TEMPLATE.roundLimit,
        board: true,
      },
      ...(maxPerQuest === undefined ? {} : { maxPerQuest }),
      at: this.deps.clock.now(),
    })
    return filed
  }
}
