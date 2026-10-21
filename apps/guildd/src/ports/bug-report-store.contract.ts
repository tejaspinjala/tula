import { describe, expect, test } from 'bun:test'
import type { BugReportStore, NewBugReport } from './bug-report-store'
import { reproductionHash } from './bug-report-store'
import type { QuestQueue } from './quest-queue'

/** A store under test, with the Quest queue its Fix Quests are posted to; a database-backed store needs real guilds. */
export interface BugReportStoreFixture {
  store: BugReportStore
  quests: Pick<QuestQueue, 'get' | 'list'>
  newGuild: () => Promise<string>
}

const T0 = new Date('2026-01-01T00:00:00.000Z')

function made(over: Partial<NewBugReport> = {}, tag: string = crypto.randomUUID()): NewBugReport {
  const repro = { steps: `step ${tag}`, expected: 'it works', actual: 'it breaks' }
  return {
    owningHall: 'heralds',
    title: 'The brief loses its heading',
    reproduction: repro,
    evidence: ['a'.repeat(64)],
    filer: { kind: 'member', questId: crypto.randomUUID(), hallId: 'forge', memberId: 'm-ada' },
    fixQuest: {
      jobKey: `fix:${crypto.randomUUID()}`,
      templateId: 'fix-quest',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Fix: the brief loses its heading',
      ownerId: 'heralds-member-2',
      doneCondition: 'Fix it',
      roundLimit: 2,
      board: true,
    },
    maxPerQuest: 5,
    at: T0,
    ...over,
  }
}

/** The BugReportStore contract, run against every adapter. `make` returns a fresh store. */
export function bugReportStoreContract(name: string, make: () => Promise<BugReportStoreFixture>) {
  describe(`BugReportStore contract: ${name}`, () => {
    test('filing stores an open report and posts its Fix Quest on the owning Hall board', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const input = made()
      const filed = await store.file(g, input)
      expect(filed.ok).toBe(true)
      if (!filed.ok) {
        return
      }
      expect(filed.report).toMatchObject({
        owningHall: 'heralds',
        title: input.title,
        reproduction: input.reproduction,
        reproductionHash: reproductionHash('heralds', input.reproduction),
        evidence: input.evidence,
        filer: input.filer,
        status: 'open',
        duplicateOf: null,
        fixHandoffHash: null,
        fixedAt: null,
      })
      expect(filed.fixQuest).toMatchObject({ hallId: 'heralds', board: true, state: 'queued' })
      expect(filed.report.fixQuestId).toBe(filed.fixQuest?.id ?? 'none')
      expect(await quests.get(g, filed.fixQuest?.id ?? '')).toMatchObject({
        templateId: 'fix-quest',
      })
      expect(await store.get(g, filed.report.id)).toEqual(filed.report)
      expect(await store.forFixQuest(g, filed.fixQuest?.id ?? '')).toEqual(filed.report)
    })

    test('a second report with the same reproduction while one is open is stored duplicate, linked, and posts nothing', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const first = await store.file(g, made({}, 'same'))
      const second = await store.file(g, made({}, 'same'))
      if (!first.ok || !second.ok) {
        throw new Error('filing failed')
      }
      expect(second.report).toMatchObject({
        status: 'duplicate',
        duplicateOf: first.report.id,
        fixQuestId: null,
      })
      expect(second.fixQuest).toBeNull()
      expect((await quests.list(g, { limit: 10 })).quests).toHaveLength(1)
    })

    test('the same reproduction against another Hall is not a duplicate', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.file(g, made({}, 'same'))
      const other = await store.file(g, made({ owningHall: 'scribes' }, 'same'))
      expect(other.ok && other.report.status).toBe('open')
    })

    test('two concurrent filings of one defect leave one open and one duplicate', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const both = await Promise.all([
        store.file(g, made({}, 'race')),
        store.file(g, made({}, 'race')),
      ])
      const statuses = both.map((r) => (r.ok ? r.report.status : 'refused')).sort()
      expect(statuses).toEqual(['duplicate', 'open'])
      expect((await quests.list(g, { limit: 10 })).quests).toHaveLength(1)
    })

    test('a Member past its cap is refused bug_report_cap and nothing is posted; the Guild Master has none', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const filer = {
        kind: 'member' as const,
        questId: crypto.randomUUID(),
        hallId: 'forge',
        memberId: 'm',
      }
      expect((await store.file(g, made({ filer, maxPerQuest: 1 }))).ok).toBe(true)
      expect(await store.file(g, made({ filer, maxPerQuest: 1 }))).toEqual({
        ok: false,
        error: 'bug_report_cap',
      })
      expect(await store.countForQuest(g, filer.questId)).toBe(1)
      expect((await quests.list(g, { limit: 10 })).quests).toHaveLength(1)
      for (let i = 0; i < 3; i++) {
        expect(
          (await store.file(g, made({ filer: { kind: 'guild_master' }, maxPerQuest: 1 }))).ok
        ).toBe(true)
      }
    })

    test('concurrent filings by one Quest cannot overshoot the cap', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const filer = {
        kind: 'member' as const,
        questId: crypto.randomUUID(),
        hallId: 'forge',
        memberId: 'm',
      }
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => store.file(g, made({ filer, maxPerQuest: 2 })))
      )
      expect(results.filter((r) => r.ok)).toHaveLength(2)
      expect(await store.countForQuest(g, filer.questId)).toBe(2)
    })

    test('a duplicate is charged against the cap too', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const filer = {
        kind: 'member' as const,
        questId: crypto.randomUUID(),
        hallId: 'forge',
        memberId: 'm',
      }
      await store.file(g, made({ filer, maxPerQuest: 2 }, 'x'))
      const dup = await store.file(g, made({ filer, maxPerQuest: 2, title: 'Another view' }, 'x'))
      expect(dup.ok && dup.report.status).toBe('duplicate')
      expect((await store.file(g, made({ filer, maxPerQuest: 2 }))).ok).toBe(false)
    })

    test('a retried identical request returns the first report and is not charged again', async () => {
      const { store, quests, newGuild } = await make()
      const g = await newGuild()
      const filer = {
        kind: 'member' as const,
        questId: crypto.randomUUID(),
        hallId: 'forge',
        memberId: 'm',
      }
      const input = made({ filer, maxPerQuest: 1 }, 'retry')
      const first = await store.file(g, input)
      const again = await store.file(g, input)
      expect(first.ok && again.ok && again.report.id === first.report.id).toBe(true)
      expect(await store.countForQuest(g, filer.questId)).toBe(1)
      expect((await quests.list(g, { limit: 50 })).quests).toHaveLength(1)
    })

    test('lists a Hall newest first in pages, filtered by status', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const ids: string[] = []
      for (const tag of ['a', 'b', 'c']) {
        const f = await store.file(g, made({}, tag))
        ids.push(f.ok ? f.report.id : '')
      }
      await store.file(g, made({}, 'a'))
      await store.file(g, made({ owningHall: 'scribes' }, 'z'))
      const one = await store.list(g, { hallId: 'heralds', limit: 2 })
      expect(one.reports.map((r) => r.status)).toEqual(['duplicate', 'open'])
      expect(one.next).not.toBeNull()
      const two = await store.list(g, {
        hallId: 'heralds',
        limit: 2,
        ...(one.next === null ? {} : { after: one.next }),
      })
      expect(two.reports.map((r) => r.id)).toEqual([ids[1] ?? '', ids[0] ?? ''])
      expect(two.next).toBeNull()
      const open = await store.list(g, { hallId: 'heralds', status: 'open', limit: 10 })
      expect(open.reports).toHaveLength(3)
      expect(
        (await store.list(g, { hallId: 'heralds', status: 'fixed', limit: 10 })).reports
      ).toEqual([])
    })

    test('another guild sees none of it', async () => {
      const { store, quests, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      const filed = await store.file(a, made())
      const id = filed.ok ? filed.report.id : ''
      const fixId = filed.ok ? (filed.fixQuest?.id ?? '') : ''
      expect(await store.get(b, id)).toBeNull()
      expect(await store.forFixQuest(b, fixId)).toBeNull()
      expect(await store.list(b, { hallId: 'heralds', limit: 10 })).toEqual({
        reports: [],
        next: null,
      })
      expect(await store.countForQuest(b, '00000000-0000-4000-8000-000000000000')).toBe(0)
      expect(await quests.get(b, fixId)).toBeNull()
    })
  })
}
