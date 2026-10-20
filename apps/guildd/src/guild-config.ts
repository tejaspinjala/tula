import { z } from 'zod'
import { canonicalJson } from './audit-chain'

const slug = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const displayName = z.string().trim().min(1).max(100)

/** Most Halls, Members, providers, profiles or schedules one config may hold (bounds the document). */
const MAX_ITEMS = 50

/** A worker agent's rank; maps to a model tier in routing, never to a model id here. */
export const memberRank = z.enum(['apprentice', 'journeyman', 'adept'])

const agent = z.object({ id: slug, name: displayName })

/** A Member: a worker agent with a rank. */
export const member = agent.extend({ rank: memberRank })

/** A Hall: a department of the guild, with its Captain and Members. */
export const hall = z.object({
  id: slug,
  name: displayName,
  /** `private` Halls (Health, Relationships, Personal) hold data that must never leave private routes. */
  kind: z.enum(['work', 'private']),
  /** A locked Hall accepts no Quests. */
  locked: z.boolean(),
  /** Whether the Hall's work may be routed privately; enabling it widens risk. */
  privateEligible: z.boolean(),
  captain: agent.nullable(),
  members: z.array(member).max(MAX_ITEMS),
})

/** Seal Policy levels, strictest first: what needs a Seal and what agents may do alone. */
export const SEAL_POLICY_LEVELS = ['always', 'routine_alone', 'autonomous'] as const
export const sealPolicy = z.enum(SEAL_POLICY_LEVELS)

/**
 * Per-provider auth (ADR-0005): the Guild Master picks `subscription` or `api_key` per provider.
 */
export const provider = z.object({
  id: slug,
  auth: z.enum(['subscription', 'api_key']),
  /**
   * Whether this provider may serve private-class work. Only the Guild Master sets it; turning
   * it on is a widening change (a new or edited provider never matches a prior one).
   */
  privateEligible: z.boolean().default(false),
})

/**
 * Token prices in millionths of a dollar per million tokens (so $3 per million is 3_000_000).
 * Prices live in guild config, never in engine code: the spec leaves them an open item (O4).
 */
export const tokenPrice = z.object({
  inputMicrosPerMTok: z.number().int().min(0).max(1_000_000_000),
  outputMicrosPerMTok: z.number().int().min(0).max(1_000_000_000),
})

/**
 * A routing profile: which provider serves which model tier (cheap, mid, deep). `model` is the
 * provider's model id, the only place one lives; `price` is required for `api_key` providers
 * to meter dollars (the gateway refuses an unpriced api_key call, so caps cannot be bypassed).
 */
export const routingProfile = z.object({
  id: slug,
  provider: slug,
  tier: z.enum(['cheap', 'mid', 'deep']),
  model: z.string().trim().min(1).max(200).optional(),
  price: tokenPrice.optional(),
})

/** A recurring schedule, as a five-field cron expression. */
export const schedule = z.object({ id: slug, cron: z.string().trim().min(1).max(100) })

/** Spending and usage caps; raising one widens risk. */
export const caps = z.object({
  dailyTokens: z.number().int().min(0).max(1_000_000_000_000),
  dailySpendCents: z.number().int().min(0).max(100_000_000),
  /** Quests that may hold a live lease at once; {@link DEFAULT_CONCURRENT_QUESTS} when absent. */
  concurrentQuests: z.number().int().min(1).max(1000).optional(),
})

/** The Quest concurrency cap of a config that does not set one. */
export const DEFAULT_CONCURRENT_QUESTS = 4

/** The guild's effective Tripwire thresholds. */
export function guildTripwires(config: GuildConfig): TripwireThresholds {
  return config.tripwires ?? DEFAULT_TRIPWIRES
}

/** The guild's effective Treasury envelope limits. */
export function guildTreasury(config: GuildConfig): TreasuryLimits {
  return config.treasury ?? DEFAULT_TREASURY
}

/** The guild's Quest concurrency cap: how many Quests may be leased at once. */
export function questConcurrency(config: GuildConfig): number {
  return config.caps.concurrentQuests ?? DEFAULT_CONCURRENT_QUESTS
}

/**
 * Tripwire thresholds (data, not code): when a Hall's usage crosses one, the Hall is paused.
 * Lowering a threshold tightens; raising one widens risk.
 */
export const tripwireThresholds = z.object({
  /** Pause when today's tokens exceed this multiple of the 7-day median. */
  tokenBurnMultiple: z.number().min(1).max(1000),
  /** Pause when gate denials in the last hour reach this count. */
  gateDenialsPerHour: z.number().int().min(1).max(100_000),
  /** Pause when one action repeats this many times. */
  loopRepeats: z.number().int().min(2).max(100_000),
})
/** Tripwire thresholds. */
export type TripwireThresholds = z.infer<typeof tripwireThresholds>

/** The thresholds a new guild is founded with, and those used by a config that sets none. */
export const DEFAULT_TRIPWIRES: TripwireThresholds = {
  tokenBurnMultiple: 3,
  gateDenialsPerHour: 10,
  loopRepeats: 5,
}

/**
 * The paper Treasury's envelope limits, in integer cents and whole percents (data, not code).
 * Raising a spend limit, or lowering a share held back, widens risk.
 */
export const treasuryLimits = z.object({
  /** Most the Treasurer lets out in one UTC day; the Guild Master alone approves beyond it. */
  dailyCapCents: z.number().int().min(0).max(100_000_000),
  /** Largest single spend the Treasurer may approve alone; larger needs the Guild Master. */
  treasurerLimitCents: z.number().int().min(0).max(100_000_000),
  /** Share of the starting funds held in reserve, released only by the Guild Master. */
  reservePercent: z.number().int().min(0).max(100),
  /** Share of each revenue entry reinvested into the operating envelope. */
  reinvestPercent: z.number().int().min(0).max(100),
})
/** The Treasury envelope limits. */
export type TreasuryLimits = z.infer<typeof treasuryLimits>

/** The limits a new guild is founded with: $10 a day, $5 Treasurer limit, 30% reserve, 40% reinvest. */
export const DEFAULT_TREASURY: TreasuryLimits = {
  dailyCapCents: 1000,
  treasurerLimitCents: 500,
  reservePercent: 30,
  reinvestPercent: 40,
}

/** The whole versioned guild config: Halls, roles, Members, routing profiles, Seal Policy, caps, schedules. */
export const guildConfig = z
  .object({
    steward: agent,
    halls: z.array(hall).max(MAX_ITEMS),
    sealPolicy,
    caps,
    providers: z.array(provider).max(MAX_ITEMS),
    routingProfiles: z.array(routingProfile).max(MAX_ITEMS),
    schedules: z.array(schedule).max(MAX_ITEMS),
    /** Absent in configs older than Tripwires; {@link DEFAULT_TRIPWIRES} then applies. */
    tripwires: tripwireThresholds.optional(),
    /** Absent in configs older than the Treasury; {@link DEFAULT_TREASURY} then applies. */
    treasury: treasuryLimits.optional(),
  })
  .superRefine((config, ctx) => {
    const known = new Set(config.providers.map((p) => p.id))
    for (const [i, profile] of config.routingProfiles.entries()) {
      if (!known.has(profile.provider)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routingProfiles', i, 'provider'],
          message: 'routing profile names an unconfigured provider',
        })
      }
    }
    const ids = config.halls.map((h) => h.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['halls'], message: 'duplicate Hall id' })
    }
  })

/** A guild's config document. */
export type GuildConfig = z.infer<typeof guildConfig>
/** One Hall of the config. */
export type Hall = z.infer<typeof hall>

/**
 * The config a new guild is founded with: the Steward, the Heralds Hall with its Captain and
 * Members, the locked Health, Relationships and Personal Halls, and Seal Policy `always`.
 */
export function defaultConfig(): GuildConfig {
  const locked = (id: string, name: string): Hall => ({
    id,
    name,
    kind: 'private',
    locked: true,
    privateEligible: false,
    captain: null,
    members: [],
  })
  return {
    steward: { id: 'steward', name: 'Steward' },
    halls: [
      {
        id: 'heralds',
        name: 'Heralds Hall',
        kind: 'work',
        locked: false,
        privateEligible: false,
        captain: { id: 'heralds-captain', name: 'Herald Captain' },
        members: [
          { id: 'heralds-member-1', name: 'Herald Apprentice', rank: 'apprentice' },
          { id: 'heralds-member-2', name: 'Herald Journeyman', rank: 'journeyman' },
        ],
      },
      locked('health', 'Health'),
      locked('relationships', 'Relationships'),
      locked('personal', 'Personal'),
    ],
    sealPolicy: 'always',
    caps: { dailyTokens: 1_000_000, dailySpendCents: 1_000 },
    providers: [],
    routingProfiles: [],
    schedules: [],
    tripwires: DEFAULT_TRIPWIRES,
    treasury: DEFAULT_TREASURY,
  }
}

/** How a change moves risk: `widening` needs confirmation, `tightening` and `neutral` apply at once. */
export type ChangeKind = 'widening' | 'tightening' | 'neutral'

const RANKS = memberRank.options

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const entriesOf = (o: object): Map<string, unknown> => new Map(Object.entries(o))

/** Whether every key outside `handled` is identical in both objects (unknown keys never change silently). */
function othersSame(a: object, b: object, handled: readonly string[]): boolean {
  const left = entriesOf(a)
  const right = entriesOf(b)
  const keys = new Set([...left.keys(), ...right.keys()])
  return [...keys].every((k) => handled.includes(k) || same(left.get(k), right.get(k)))
}

/** Every item of `next` is present, identical, in `prev` (items may be removed, never added or edited). */
function subsetOf<T extends { id: string }>(prev: readonly T[], next: readonly T[]): boolean {
  const before = new Map(prev.map((p) => [p.id, p]))
  return next.every((n) => {
    const p = before.get(n.id)
    return p !== undefined && same(p, n)
  })
}

type Agent = { id: string; name: string }
type Member = GuildConfig['halls'][number]['members'][number]

function memberNoWider(prev: Member, next: Member): boolean {
  return (
    RANKS.indexOf(next.rank) <= RANKS.indexOf(prev.rank) && othersSame(prev, next, ['name', 'rank'])
  )
}

function hallNoWider(prev: Hall, next: Hall): boolean {
  const members = new Map(prev.members.map((m) => [m.id, m]))
  return (
    next.kind === prev.kind &&
    (next.locked || !prev.locked) &&
    (!next.privateEligible || prev.privateEligible) &&
    (next.captain === null ||
      (prev.captain?.id === next.captain.id && othersSame(prev.captain, next.captain, ['name']))) &&
    next.members.every((m) => {
      const before = members.get(m.id)
      return before !== undefined && memberNoWider(before, m)
    }) &&
    othersSame(prev, next, ['name', 'kind', 'locked', 'privateEligible', 'captain', 'members'])
  )
}

function tripwiresNoWider(prev: TripwireThresholds, next: TripwireThresholds): boolean {
  return (
    next.tokenBurnMultiple <= prev.tokenBurnMultiple &&
    next.gateDenialsPerHour <= prev.gateDenialsPerHour &&
    next.loopRepeats <= prev.loopRepeats
  )
}

function treasuryNoWider(prev: TreasuryLimits, next: TreasuryLimits): boolean {
  return (
    next.dailyCapCents <= prev.dailyCapCents &&
    next.treasurerLimitCents <= prev.treasurerLimitCents &&
    next.reservePercent >= prev.reservePercent &&
    next.reinvestPercent >= prev.reinvestPercent &&
    othersSame(prev, next, [
      'dailyCapCents',
      'treasurerLimitCents',
      'reservePercent',
      'reinvestPercent',
    ])
  )
}

/** True only when `next` is provably no riskier than `prev`, field by field; anything else fails closed. */
function provablyNoWider(prev: GuildConfig, next: GuildConfig): boolean {
  const level = (p: GuildConfig['sealPolicy']) => SEAL_POLICY_LEVELS.indexOf(p)
  const stewardOk = (a: Agent, b: Agent) => a.id === b.id && othersSame(a, b, ['name'])
  const prevHalls = new Map(prev.halls.map((h) => [h.id, h]))
  const nextIds = new Set(next.halls.map((h) => h.id))
  const removedHallsOk = prev.halls.every(
    (h) => nextIds.has(h.id) || (!h.locked && h.kind !== 'private')
  )
  return (
    stewardOk(prev.steward, next.steward) &&
    level(next.sealPolicy) <= level(prev.sealPolicy) &&
    next.caps.dailyTokens <= prev.caps.dailyTokens &&
    next.caps.dailySpendCents <= prev.caps.dailySpendCents &&
    questConcurrency(next) <= questConcurrency(prev) &&
    othersSame(prev.caps, next.caps, ['dailyTokens', 'dailySpendCents', 'concurrentQuests']) &&
    subsetOf(prev.providers, next.providers) &&
    subsetOf(prev.routingProfiles, next.routingProfiles) &&
    subsetOf(prev.schedules, next.schedules) &&
    tripwiresNoWider(guildTripwires(prev), guildTripwires(next)) &&
    treasuryNoWider(guildTreasury(prev), guildTreasury(next)) &&
    removedHallsOk &&
    next.halls.every((h) => {
      const before = prevHalls.get(h.id)
      return before !== undefined && hallNoWider(before, h)
    }) &&
    othersSame(prev, next, [
      'steward',
      'halls',
      'sealPolicy',
      'caps',
      'providers',
      'routingProfiles',
      'schedules',
      'tripwires',
      'treasury',
    ])
  )
}

/** Drops display names at every depth, leaving only what can carry risk. */
function withoutNames(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutNames)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'name')
        .map(([k, v]) => [k, withoutNames(v)])
    )
  }
  return value
}

/**
 * Deterministic comparison of two configs, failing closed: only a provable field-by-field subset
 * of risk (caps down, Seal Policy stricter, private eligibility off, Halls locked, Members,
 * Captains, providers, profiles, schedules and unlocked work Halls removed, rank down) is
 * `tightening` or `neutral`. Everything else, including any field this classifier does not know,
 * is `widening`; so is removing a locked or private Hall (decision: widening, not rejected).
 * Never a model decision.
 */
export function classifyChange(prev: GuildConfig, next: GuildConfig): ChangeKind {
  if (!provablyNoWider(prev, next)) {
    return 'widening'
  }
  // Absent optional sections mean their defaults, so compare the effective configs.
  const effective = (c: GuildConfig) =>
    withoutNames({ ...c, tripwires: guildTripwires(c), treasury: guildTreasury(c) })
  return same(effective(prev), effective(next)) ? 'neutral' : 'tightening'
}

/** Whether a Hall takes Quests: locked Halls reject them. */
export function hallAcceptsQuests(
  config: GuildConfig,
  hallId: string
): { ok: true } | { ok: false; error: 'hall_locked' | 'hall_not_found' } {
  const found = config.halls.find((h) => h.id === hallId)
  if (!found) {
    return { ok: false, error: 'hall_not_found' }
  }
  return found.locked ? { ok: false, error: 'hall_locked' } : { ok: true }
}
