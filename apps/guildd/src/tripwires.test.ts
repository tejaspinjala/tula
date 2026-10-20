import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryTripwireStore } from './adapters/memory-tripwire-store'
import { classifyChange, defaultConfig, type GuildConfig, guildTripwires } from './guild-config'
import type { TripwireKind } from './ports/tripwire-store'
import { evaluateTripwires, type HallUsage, runTripwires } from './tripwires'

const runs = { revokeHallRuns: async () => 0 }
const thresholds = { tokenBurnMultiple: 3, gateDenialsPerHour: 5, loopRepeats: 4 }
const calm: HallUsage = {
  tokensToday: 1000,
  tokensPerDay7d: [900, 1000, 1100, 1000, 950, 1050, 1000],
  gateDenialsLastHour: 0,
  maxActionRepeats: 1,
}

describe('evaluateTripwires', () => {
  test('calm usage trips nothing', () => {
    expect(evaluateTripwires(thresholds, calm)).toBeNull()
  })

  test('token burn trips above the multiple of the 7-day median, not at it', () => {
    expect(evaluateTripwires(thresholds, { ...calm, tokensToday: 3000 })).toBeNull()
    expect(evaluateTripwires(thresholds, { ...calm, tokensToday: 3001 })).toEqual({
      tripwire: 'token_burn',
      observed: 3001,
      threshold: 3000,
    })
  })

  test('the median ignores a single outlier day', () => {
    const outlier = { ...calm, tokensPerDay7d: [1000, 1000, 1000, 1000, 1000, 1000, 900_000] }
    expect(evaluateTripwires(thresholds, { ...outlier, tokensToday: 2500 })).toBeNull()
  })

  test('no baseline means no token burn trip', () => {
    expect(
      evaluateTripwires(thresholds, { ...calm, tokensPerDay7d: [], tokensToday: 9_000_000 })
    ).toBeNull()
  })

  test('repeated gate denials trip at the hourly limit', () => {
    expect(evaluateTripwires(thresholds, { ...calm, gateDenialsLastHour: 4 })).toBeNull()
    expect(evaluateTripwires(thresholds, { ...calm, gateDenialsLastHour: 5 })).toEqual({
      tripwire: 'gate_denials',
      observed: 5,
      threshold: 5,
    })
  })

  test('loop detection trips when one action repeats at the limit', () => {
    expect(evaluateTripwires(thresholds, { ...calm, maxActionRepeats: 3 })).toBeNull()
    expect(evaluateTripwires(thresholds, { ...calm, maxActionRepeats: 4 })).toEqual({
      tripwire: 'loop',
      observed: 4,
      threshold: 4,
    })
  })
})

async function setup(override?: (c: GuildConfig) => GuildConfig) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const tripwires = new MemoryTripwireStore(clock)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  if (override) {
    const { config: current } = await config.current(guild)
    await config.propose(guild, override(current))
  }
  return { config, tripwires, guild }
}

describe('runTripwires', () => {
  test('each Tripwire pauses its Hall from scripted usage, with thresholds from the guild config', async () => {
    const cases: Array<[Partial<HallUsage>, TripwireKind]> = [
      [{ tokensToday: 10_000_000 }, 'token_burn'],
      [{ gateDenialsLastHour: 50 }, 'gate_denials'],
      [{ maxActionRepeats: 50 }, 'loop'],
    ]
    for (const [usage, kind] of cases) {
      const { config, tripwires, guild } = await setup()
      const outcome = await runTripwires({ config, tripwires, runs }, guild, 'heralds', {
        ...calm,
        ...usage,
      })
      expect(outcome.paused).toBe(true)
      expect(await tripwires.isPaused(guild, 'heralds')).toBe(true)
      expect((await tripwires.list(guild, { limit: 5 })).pauses[0]?.tripwire).toBe(kind)
    }
  })

  test('calm usage leaves the Hall running', async () => {
    const { config, tripwires, guild } = await setup()
    const outcome = await runTripwires({ config, tripwires, runs }, guild, 'heralds', calm)
    expect(outcome.paused).toBe(false)
    expect(await tripwires.isPaused(guild, 'heralds')).toBe(false)
  })

  test('a lower configured threshold trips on usage the defaults allow', async () => {
    const { config, tripwires, guild } = await setup((c) => ({
      ...c,
      tripwires: { tokenBurnMultiple: 3, gateDenialsPerHour: 2, loopRepeats: 4 },
    }))
    await runTripwires({ config, tripwires, runs }, guild, 'heralds', {
      ...calm,
      gateDenialsLastHour: 2,
    })
    expect(await tripwires.isPaused(guild, 'heralds')).toBe(true)
  })

  test('defaultConfig carries the thresholds, and raising one widens risk', () => {
    const base = defaultConfig()
    const tripwires = guildTripwires(base)
    expect(base.tripwires).toEqual(tripwires)
    expect(
      classifyChange(base, { ...base, tripwires: { ...tripwires, gateDenialsPerHour: 1 } })
    ).toBe('tightening')
    expect(
      classifyChange(base, {
        ...base,
        tripwires: { ...tripwires, loopRepeats: tripwires.loopRepeats + 1 },
      })
    ).toBe('widening')
  })
})
