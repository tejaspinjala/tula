import { describe, expect, test } from 'bun:test'
import type { ActivityLog, NewActivity } from './activity-log'

/** A log under test; a database-backed log needs real guilds. */
export interface ActivityLogFixture {
  log: ActivityLog
  newGuild: () => Promise<string>
}

const T0 = new Date('2026-01-01T00:00:00.000Z')

function act(over: Partial<NewActivity> = {}): NewActivity {
  return {
    questId: crypto.randomUUID(),
    memberId: 'm-ada',
    hallId: 'h-forge',
    activity: 'reading_archive',
    at: T0,
    windowMs: 5000,
    ...over,
  }
}

/** The ActivityLog contract, run against every adapter. `make` returns a fresh log. */
export function activityLogContract(name: string, make: () => Promise<ActivityLogFixture>) {
  describe(`ActivityLog contract: ${name}`, () => {
    test('the first activity of a Member is emitted', async () => {
      const { log, newGuild } = await make()
      expect(await log.record(await newGuild(), act())).toEqual({ emitted: true })
    })

    test('the same Member and activity inside the window coalesce into one', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      await log.record(g, act())
      expect(await log.record(g, act({ at: new Date(T0.getTime() + 4999) }))).toEqual({
        emitted: false,
      })
    })

    test('the same activity after the window is emitted again', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      await log.record(g, act())
      expect(await log.record(g, act({ at: new Date(T0.getTime() + 5000) }))).toEqual({
        emitted: true,
      })
    })

    test('a different activity or a different Member is its own event', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      await log.record(g, act())
      expect((await log.record(g, act({ activity: 'writing_archive' }))).emitted).toBe(true)
      expect((await log.record(g, act({ memberId: 'm-bo' }))).emitted).toBe(true)
    })

    test('concurrent records of one Member and activity emit exactly one', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      const results = await Promise.all(Array.from({ length: 8 }, () => log.record(g, act())))
      expect(results.filter((r) => r.emitted)).toHaveLength(1)
    })

    test('guilds coalesce independently', async () => {
      const { log, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await log.record(a, act())
      expect((await log.record(b, act())).emitted).toBe(true)
    })
  })
}
