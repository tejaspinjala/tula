import { z } from 'zod'

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
export const provider = z.object({ id: slug, auth: z.enum(['subscription', 'api_key']) })

/** A routing profile: which provider serves which model tier (cheap, mid, deep). */
export const routingProfile = z.object({
  id: slug,
  provider: slug,
  tier: z.enum(['cheap', 'mid', 'deep']),
})

/** A recurring schedule, as a five-field cron expression. */
export const schedule = z.object({ id: slug, cron: z.string().trim().min(1).max(100) })

/** Spending and usage caps; raising one widens risk. */
export const caps = z.object({
  dailyTokens: z.number().int().min(0).max(1_000_000_000_000),
  dailySpendCents: z.number().int().min(0).max(100_000_000),
})

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
  }
}

/** How a change moves risk: `widening` needs confirmation, `tightening` and `neutral` apply at once. */
export type ChangeKind = 'widening' | 'tightening' | 'neutral'

/**
 * Deterministic comparison of two configs. Any single risk-widening difference makes the whole
 * change `widening`: higher caps, a looser Seal Policy, private eligibility switched on, a Hall
 * unlocked, or a provider added. Never a model decision.
 */
export function classifyChange(prev: GuildConfig, next: GuildConfig): ChangeKind {
  const level = (p: GuildConfig['sealPolicy']) => SEAL_POLICY_LEVELS.indexOf(p)
  const prevHalls = new Map(prev.halls.map((h) => [h.id, h]))
  const prevProviders = new Set(prev.providers.map((p) => p.id))
  const widening =
    level(next.sealPolicy) > level(prev.sealPolicy) ||
    next.caps.dailyTokens > prev.caps.dailyTokens ||
    next.caps.dailySpendCents > prev.caps.dailySpendCents ||
    next.providers.some((p) => !prevProviders.has(p.id)) ||
    next.halls.some((h) => {
      const before = prevHalls.get(h.id)
      return (
        (h.privateEligible && !before?.privateEligible) || (before?.locked === true && !h.locked)
      )
    })
  if (widening) {
    return 'widening'
  }
  const nextHalls = new Map(next.halls.map((h) => [h.id, h]))
  const nextProviders = new Set(next.providers.map((p) => p.id))
  const tightening =
    level(next.sealPolicy) < level(prev.sealPolicy) ||
    next.caps.dailyTokens < prev.caps.dailyTokens ||
    next.caps.dailySpendCents < prev.caps.dailySpendCents ||
    prev.providers.some((p) => !nextProviders.has(p.id)) ||
    prev.halls.some((h) => {
      const after = nextHalls.get(h.id)
      return (h.privateEligible && !after?.privateEligible) || (!h.locked && after?.locked === true)
    })
  return tightening ? 'tightening' : 'neutral'
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
