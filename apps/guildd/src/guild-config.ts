import { z } from 'zod'
import { canonicalJson } from './audit-chain'
import { characterLook } from './look-catalogue'
import type { ClaimOptions } from './ports/quest-queue'
import { type ContentPolicy, DEFAULT_POLICY } from './verdict'

const slug = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const displayName = z.string().trim().min(1).max(100)

/** Most Halls, Members, providers, profiles or schedules one config may hold (bounds the document). */
const MAX_ITEMS = 50

/** A worker agent's rank; maps to a model tier in routing, never to a model id here. */
export const memberRank = z.enum(['apprentice', 'journeyman', 'adept'])

/** The addressee of a Missive to a whole Hall, so no Member, Captain or Steward may carry it as an id. */
const agentId = slug.refine((id) => id !== 'hall', { message: 'hall is a reserved id' })

const agent = z.strictObject({ id: agentId, name: displayName })

/** A Member: a worker agent with a rank. */
export const member = agent.extend({
  rank: memberRank,
  /** Overrides the look generated from the Member id; cosmetic, so changing it is neutral. */
  look: characterLook.optional(),
})

/** A Hall: a department of the guild, with its Captain and Members. */
export const hall = z.strictObject({
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
  /**
   * Quests of this Hall that may hold a live lease at once; {@link DEFAULT_MAX_CONCURRENT_MEMBERS} when
   * absent. Raising it widens risk. Only live-leased `active` Quests count (a parked parent or a
   * Quest awaiting a Seal holds no slot), and the Captain's own plan Quest is outside it, so a cap of
   * 1 still runs one Member.
   */
  maxConcurrentMembers: z.number().int().min(1).max(1000).optional(),
})

/** Seal Policy levels, strictest first: what needs a Seal and what agents may do alone. */
export const SEAL_POLICY_LEVELS = ['always', 'routine_alone', 'autonomous'] as const
export const sealPolicy = z.enum(SEAL_POLICY_LEVELS)

/**
 * Per-provider auth (ADR-0005): the Guild Master picks `subscription` or `api_key` per provider.
 */
export const provider = z.strictObject({
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
export const tokenPrice = z.strictObject({
  inputMicrosPerMTok: z.number().int().min(0).max(1_000_000_000),
  outputMicrosPerMTok: z.number().int().min(0).max(1_000_000_000),
})

/**
 * A routing profile: which provider serves which model tier (cheap, mid, deep). `model` is the
 * provider's model id, the only place one lives; `price` is required for `api_key` providers
 * to meter dollars (the gateway refuses an unpriced api_key call, so caps cannot be bypassed).
 */
export const routingProfile = z.strictObject({
  id: slug,
  provider: slug,
  tier: z.enum(['cheap', 'mid', 'deep']),
  model: z.string().trim().min(1).max(200).optional(),
  price: tokenPrice.optional(),
})

/** A recurring schedule, as a five-field cron expression. */
export const schedule = z.strictObject({ id: slug, cron: z.string().trim().min(1).max(100) })

/** Spending and usage caps; raising one widens risk. */
export const caps = z.strictObject({
  dailyTokens: z.number().int().min(0).max(1_000_000_000_000),
  dailySpendCents: z.number().int().min(0).max(100_000_000),
  /** Quests that may hold a live lease at once; {@link DEFAULT_CONCURRENT_QUESTS} when absent. */
  concurrentQuests: z.number().int().min(1).max(1000).optional(),
  /** Hours an approved Seal may wait to be posted before it expires; {@link DEFAULT_SEAL_POST_WINDOW_HOURS} when absent. Raising it widens risk. */
  sealPostWindowHours: z.number().int().min(1).max(8760).optional(),
  /** Sub-Quests one Quest may spawn; {@link DEFAULT_MAX_CHILDREN_PER_QUEST} when absent. Raising it widens risk. */
  maxChildrenPerQuest: z.number().int().min(0).max(20).optional(),
  /** How deep sub-Quests may nest; {@link DEFAULT_MAX_SPAWN_DEPTH} when absent. Raising it widens risk. */
  maxSpawnDepth: z.number().int().min(0).max(5).optional(),
  /** Board Quests a Captain may post under one Campaign; {@link DEFAULT_MAX_QUESTS_PER_CAMPAIGN} when absent. Counts board Quests only (Sub-Quests are bounded by the spawn caps). Raising it widens risk. */
  maxQuestsPerCampaign: z.number().int().min(0).max(100).optional(),
  /** Missives one Quest may send; {@link DEFAULT_MAX_MISSIVES_PER_QUEST} when absent. Raising it widens risk. */
  maxMissivesPerQuest: z.number().int().min(0).max(200).optional(),
  /** Research calls one Quest may make; 0 (research off) when absent. Enabling or raising it widens risk. */
  maxResearchPerQuest: z.number().int().min(0).max(100).optional(),
  /** Inquiries one Quest may ask; {@link DEFAULT_MAX_INQUIRIES_PER_QUEST} when absent. Raising it widens risk. */
  maxInquiriesPerQuest: z.number().int().min(0).max(50).optional(),
  /** Bug Reports one Quest may file; {@link DEFAULT_MAX_BUG_REPORTS_PER_QUEST} when absent. Raising it widens risk. */
  maxBugReportsPerQuest: z.number().int().min(0).max(50).optional(),
  /** Dossiers one Quest may request; {@link DEFAULT_MAX_DOSSIERS_PER_QUEST} when absent. Raising it widens risk. */
  maxDossiersPerQuest: z.number().int().min(0).max(50).optional(),
  /** Proposals the Council of Elders may approve in a day; {@link DEFAULT_MAX_COUNCIL_APPROVALS_PER_DAY} when absent. 0 means the Council never approves. Raising it widens risk. */
  maxCouncilApprovalsPerDay: z.number().int().min(0).max(50).optional(),
  /** Council sessions that may be convened in a day; {@link DEFAULT_MAX_COUNCIL_SESSIONS_PER_DAY} when absent. Raising it widens risk. */
  maxCouncilSessionsPerDay: z.number().int().min(0).max(200).optional(),
})

/** Council approvals a guild may give per day when the config sets no cap. */
export const DEFAULT_MAX_COUNCIL_APPROVALS_PER_DAY = 5

/** Council sessions a guild may convene per day when the config sets no cap. */
export const DEFAULT_MAX_COUNCIL_SESSIONS_PER_DAY = 20

/** The guild's cap on Council approvals per day (0 means the Council never approves). */
export function councilApprovalCap(config: GuildConfig): number {
  return config.caps.maxCouncilApprovalsPerDay ?? DEFAULT_MAX_COUNCIL_APPROVALS_PER_DAY
}

/** The guild's cap on Council sessions per day. */
export function councilSessionCap(config: GuildConfig): number {
  return config.caps.maxCouncilSessionsPerDay ?? DEFAULT_MAX_COUNCIL_SESSIONS_PER_DAY
}

/** The post window of a config that does not set one (72 hours). */
export const DEFAULT_SEAL_POST_WINDOW_HOURS = 72

/** The guild's post window for approved Seals, in milliseconds. */
export function sealPostWindowMs(config: GuildConfig): number {
  return (config.caps.sealPostWindowHours ?? DEFAULT_SEAL_POST_WINDOW_HOURS) * 3_600_000
}

/** Sub-Quests one Quest may spawn when the config sets no cap. */
export const DEFAULT_MAX_CHILDREN_PER_QUEST = 3

/** Nesting depth of sub-Quests (a Quest posted by a Guild Master is depth 0) when the config sets no cap. */
export const DEFAULT_MAX_SPAWN_DEPTH = 2

/** The guild's cap on sub-Quests one Quest may spawn. */
export function spawnChildrenCap(config: GuildConfig): number {
  return config.caps.maxChildrenPerQuest ?? DEFAULT_MAX_CHILDREN_PER_QUEST
}

/** The guild's cap on how deep sub-Quests may nest. */
export function spawnDepthCap(config: GuildConfig): number {
  return config.caps.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH
}

/** Quests a Captain may post under one Campaign when the config sets no cap. */
export const DEFAULT_MAX_QUESTS_PER_CAMPAIGN = 10

/** The guild's cap on Quests posted to the Quest Board under one Campaign. */
export function campaignQuestCap(config: GuildConfig): number {
  return config.caps.maxQuestsPerCampaign ?? DEFAULT_MAX_QUESTS_PER_CAMPAIGN
}

/** Missives one Quest may send when the config sets no cap. */
export const DEFAULT_MAX_MISSIVES_PER_QUEST = 20

/** The guild's cap on Missives one Quest may send (all its attempts). */
export function missiveCap(config: GuildConfig): number {
  return config.caps.maxMissivesPerQuest ?? DEFAULT_MAX_MISSIVES_PER_QUEST
}

/** Inquiries one Quest may ask when the config sets no cap. */
export const DEFAULT_MAX_INQUIRIES_PER_QUEST = 3

/** Bug Reports one Quest may file when the config sets no cap. */
export const DEFAULT_MAX_BUG_REPORTS_PER_QUEST = 3

/** Dossiers one Quest may request when the config sets no cap. */
export const DEFAULT_MAX_DOSSIERS_PER_QUEST = 5

/** The guild's cap on Inquiries one Quest may ask (all its attempts). */
export function inquiryCap(config: GuildConfig): number {
  return config.caps.maxInquiriesPerQuest ?? DEFAULT_MAX_INQUIRIES_PER_QUEST
}

/** The guild's cap on Bug Reports one Quest may file (all its attempts). */
export function bugReportCap(config: GuildConfig): number {
  return config.caps.maxBugReportsPerQuest ?? DEFAULT_MAX_BUG_REPORTS_PER_QUEST
}

/** The guild's cap on Dossiers one Quest may request (all its attempts). */
export function dossierCap(config: GuildConfig): number {
  return config.caps.maxDossiersPerQuest ?? DEFAULT_MAX_DOSSIERS_PER_QUEST
}

/** Research calls one Quest may make when the config sets no cap: none, so research is off. */
export const DEFAULT_MAX_RESEARCH_PER_QUEST = 0

/** The guild's cap on research calls one Quest may make (all its attempts); 0 means research is off. */
export function researchCap(config: GuildConfig): number {
  return config.caps.maxResearchPerQuest ?? DEFAULT_MAX_RESEARCH_PER_QUEST
}

/** Concurrent Members of a Hall when its cap is unset: no limit beyond the guild's Quest concurrency. */
export const DEFAULT_MAX_CONCURRENT_MEMBERS = 1000

/** The most Quests of `hall` that may hold a live lease at once. */
export function hallMemberCap(hall: Pick<Hall, 'maxConcurrentMembers'>): number {
  return hall.maxConcurrentMembers ?? DEFAULT_MAX_CONCURRENT_MEMBERS
}

/** The per-Hall live-lease caps a claim enforces: only Halls that set `maxConcurrentMembers` appear. */
export function hallCaps(config: GuildConfig): Record<string, number> {
  return Object.fromEntries(
    config.halls.flatMap((h) =>
      h.maxConcurrentMembers === undefined ? [] : [[h.id, h.maxConcurrentMembers]]
    )
  )
}

/** Whether the Hall is locked in this config (an unknown Hall counts as not locked). */
export function isHallLocked(config: GuildConfig, hallId: string): boolean {
  return config.halls.some((h) => h.id === hallId && h.locked)
}

/** The ids of the locked Halls: their Quests wait, queued, and are never claimed. */
export function lockedHallIds(config: GuildConfig): string[] {
  return config.halls.filter((h) => h.locked).map((h) => h.id)
}

/** The Quest concurrency cap of a config that does not set one. */
export const DEFAULT_CONCURRENT_QUESTS = 4

/** The guild's effective Tripwire thresholds. */
export function guildTripwires(config: GuildConfig): TripwireThresholds {
  return config.tripwires ?? DEFAULT_TRIPWIRES
}

/** The content policy a Verdict applies; absent in older configs, then {@link DEFAULT_POLICY}. */
export const contentPolicy = z.strictObject({
  maxLength: z.number().int().min(1).max(20_000),
  bannedTerms: z.array(z.string().trim().min(1).max(200)).max(MAX_ITEMS),
  requiredTerms: z.array(z.string().trim().min(1).max(200)).max(MAX_ITEMS),
  /** True lets a draft that talks about the task through the Verdict; absent means rejected. */
  allowMetaDrafts: z.boolean().optional(),
})

/** The guild's effective content policy for Verdicts. */
export function guildContentPolicy(config: GuildConfig): ContentPolicy {
  return config.contentPolicy ?? DEFAULT_POLICY
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
export const tripwireThresholds = z.strictObject({
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
export const treasuryLimits = z.strictObject({
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

/** A GitHub repo as `owner/name`; a name cannot start with a dot, so `..` never reaches a URL. */
export const repoName = z
  .string()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)

/** The repos the learning Envoy may read (the Guild Master's own and Tula-Solutions repos), lower-cased. */
export function learningRepoAllowlist(config: GuildConfig): string[] {
  return (config.learningRepos ?? []).map((r) => r.toLowerCase())
}

/** Whether the learning Envoy may read `repo`: it must be on the guild's allowlist (case-insensitive). */
export function isLearningRepoAllowed(config: GuildConfig, repo: string): boolean {
  return learningRepoAllowlist(config).includes(repo.toLowerCase())
}

/** The whole versioned guild config: Halls, roles, Members, routing profiles, Seal Policy, caps, schedules. */
export const guildConfig = z
  .strictObject({
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
    /** Absent in configs older than learning suggestions; then no repo is read. Adding one widens risk. */
    learningRepos: z.array(repoName).max(MAX_ITEMS).optional(),
    /** Absent in configs older than Core Loop; {@link DEFAULT_POLICY} then applies. Loosening it widens risk. */
    contentPolicy: contentPolicy.optional(),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>()
    config.providers.forEach((p, i) => {
      if (seen.has(p.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['providers', i, 'id'],
          message: 'duplicate_provider: each provider id may appear once',
        })
      }
      seen.add(p.id)
    })
    if (config.sealPolicy === 'autonomous') {
      ctx.addIssue({
        code: 'custom',
        path: ['sealPolicy'],
        message: 'seal_policy_locked: autonomous is not available yet; use always or routine_alone',
      })
    }
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

/** Most distinct messages {@link warnOnce} remembers, so the dedupe set stays bounded. */
const MAX_REMEMBERED_WARNINGS = 100

/** Wraps `write` so a message already seen is not written again (bounded memory: oldest forgotten). */
export function warnOnce(write: (message: string) => void): (message: string) => void {
  const seen = new Set<string>()
  return (message) => {
    if (seen.has(message)) {
      return
    }
    if (seen.size >= MAX_REMEMBERED_WARNINGS) {
      seen.clear()
    }
    seen.add(message)
    write(message)
  }
}

/** Unknown-key paths named in one stored-config warning. */
const MAX_WARNED_KEYS = 10

const warnToStderr = warnOnce((m) => process.stderr.write(`${m}\n`))

/**
 * Parses a config read back from storage. Writes are strict, but a config stored before a key was
 * removed or renamed must not brick boot: unknown keys are dropped and reported through `warn`
 * (paths only, never values); any other error still throws.
 */
export function parseStoredConfig(
  raw: unknown,
  warn: (message: string) => void = warnToStderr
): GuildConfig {
  // `autonomous` is refused on write but may sit in rows stored before the lock: read it as the
  // strictest level (fail closed) instead of bricking the guild's config.
  if (typeof raw === 'object' && raw !== null && Reflect.get(raw, 'sealPolicy') === 'autonomous') {
    warn('stored guild config has sealPolicy autonomous, read as always')
    return parseStoredConfig({ ...raw, sealPolicy: 'always' }, warn)
  }
  // Duplicate provider ids are refused on write but may sit in older rows: keep the first of
  // each id rather than bricking the guild's config.
  const providers = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'providers') : null
  if (typeof raw === 'object' && raw !== null && Array.isArray(providers)) {
    const seen = new Set<unknown>()
    const kept = providers.filter((p) => {
      const id: unknown = typeof p === 'object' && p !== null ? Reflect.get(p, 'id') : undefined
      if (typeof id !== 'string') {
        return true
      }
      const fresh = !seen.has(id)
      seen.add(id)
      return fresh
    })
    if (kept.length !== providers.length) {
      warn('stored guild config has duplicate provider ids, later duplicates ignored')
      return parseStoredConfig({ ...raw, providers: kept }, warn)
    }
  }
  const strict = guildConfig.safeParse(raw)
  if (strict.success) {
    return strict.data
  }
  const unknown = strict.error.issues.flatMap((i) =>
    i.code === 'unrecognized_keys' ? [{ path: i.path, keys: i.keys }] : []
  )
  const cleaned: unknown = structuredClone(raw)
  for (const { path, keys } of unknown) {
    const parent = path.reduce<unknown>(
      (node, step) =>
        typeof node === 'object' && node !== null ? Reflect.get(node, step) : undefined,
      cleaned
    )
    if (typeof parent === 'object' && parent !== null) {
      for (const k of keys) {
        Reflect.deleteProperty(parent, k)
      }
    }
  }
  if (unknown.length > 0) {
    const paths = unknown.flatMap(({ path, keys }) => keys.map((k) => [...path, k].join('.')))
    // JSON.stringify escapes newlines, so a hostile key cannot forge a log line.
    const shown = paths.slice(0, MAX_WARNED_KEYS).map((p) => JSON.stringify(p))
    const more = paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ''
    warn(`stored guild config has unknown keys, ignored: ${shown.join(', ')}${more}`)
  }
  return guildConfig.parse(cleaned)
}

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

/**
 * The items of `next` appear in the same relative order as in `prev`. Routing profile order carries
 * authority (the first fitting profile wins, and the first is the default), so a reorder is widening.
 */
function keepsRelativeOrder<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[]
): boolean {
  const at = new Map(prev.map((p, i) => [p.id, i]))
  const positions = next.map((n) => at.get(n.id) ?? -1)
  return positions.every((p, i) => i === 0 || p > (positions[i - 1] ?? -1))
}

type Provider = GuildConfig['providers'][number]

/**
 * Every provider of `next` is in `prev` unchanged, or differs only by private eligibility going
 * off (ADR-0012: turning it off narrows where private text may go, so it applies at once).
 */
function providersNoWider(prev: readonly Provider[], next: readonly Provider[]): boolean {
  const unique = (list: readonly Provider[]) => new Set(list.map((p) => p.id)).size === list.length
  if (!unique(prev) || !unique(next)) {
    return false
  }
  const before = new Map(prev.map((p) => [p.id, p]))
  return next.every((n) => {
    const p = before.get(n.id)
    return (
      p !== undefined &&
      (!n.privateEligible || p.privateEligible) &&
      same({ ...p, privateEligible: false }, { ...n, privateEligible: false })
    )
  })
}

type Agent = { id: string; name: string }
type Member = GuildConfig['halls'][number]['members'][number]

function memberNoWider(prev: Member, next: Member): boolean {
  return (
    RANKS.indexOf(next.rank) <= RANKS.indexOf(prev.rank) &&
    othersSame(prev, next, ['name', 'rank', 'look'])
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
    hallMemberCap(next) <= hallMemberCap(prev) &&
    othersSame(prev, next, [
      'name',
      'kind',
      'locked',
      'privateEligible',
      'captain',
      'members',
      'maxConcurrentMembers',
    ])
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

function policyNoWider(prev: ContentPolicy, next: ContentPolicy): boolean {
  const covers = (more: readonly string[], fewer: readonly string[]) => {
    const have = new Set(more.map((t) => t.toLowerCase()))
    return fewer.every((t) => have.has(t.toLowerCase()))
  }
  return (
    next.maxLength <= prev.maxLength &&
    (next.allowMetaDrafts !== true || prev.allowMetaDrafts === true) &&
    covers(next.bannedTerms, prev.bannedTerms) &&
    covers(next.requiredTerms, prev.requiredTerms) &&
    othersSame(prev, next, ['maxLength', 'bannedTerms', 'requiredTerms', 'allowMetaDrafts'])
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
    sealPostWindowMs(next) <= sealPostWindowMs(prev) &&
    spawnChildrenCap(next) <= spawnChildrenCap(prev) &&
    spawnDepthCap(next) <= spawnDepthCap(prev) &&
    campaignQuestCap(next) <= campaignQuestCap(prev) &&
    missiveCap(next) <= missiveCap(prev) &&
    researchCap(next) <= researchCap(prev) &&
    inquiryCap(next) <= inquiryCap(prev) &&
    bugReportCap(next) <= bugReportCap(prev) &&
    dossierCap(next) <= dossierCap(prev) &&
    councilApprovalCap(next) <= councilApprovalCap(prev) &&
    councilSessionCap(next) <= councilSessionCap(prev) &&
    othersSame(prev.caps, next.caps, [
      'dailyTokens',
      'dailySpendCents',
      'concurrentQuests',
      'sealPostWindowHours',
      'maxChildrenPerQuest',
      'maxSpawnDepth',
      'maxQuestsPerCampaign',
      'maxMissivesPerQuest',
      'maxResearchPerQuest',
      'maxInquiriesPerQuest',
      'maxBugReportsPerQuest',
      'maxDossiersPerQuest',
      'maxCouncilApprovalsPerDay',
      'maxCouncilSessionsPerDay',
    ]) &&
    providersNoWider(prev.providers, next.providers) &&
    subsetOf(prev.routingProfiles, next.routingProfiles) &&
    keepsRelativeOrder(prev.routingProfiles, next.routingProfiles) &&
    subsetOf(prev.schedules, next.schedules) &&
    learningRepoAllowlist(next).every((r) => learningRepoAllowlist(prev).includes(r)) &&
    tripwiresNoWider(guildTripwires(prev), guildTripwires(next)) &&
    treasuryNoWider(guildTreasury(prev), guildTreasury(next)) &&
    policyNoWider(guildContentPolicy(prev), guildContentPolicy(next)) &&
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
      'learningRepos',
      'contentPolicy',
    ])
  )
}

/** Drops display names and Member looks at every depth, leaving only what can carry risk. */
function withoutNames(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutNames)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== 'name' && k !== 'look')
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
    withoutNames({
      ...c,
      tripwires: guildTripwires(c),
      treasury: guildTreasury(c),
      learningRepos: learningRepoAllowlist(c),
      contentPolicy: guildContentPolicy(c),
    })
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

/**
 * The limits every claim of a guild obeys, built from its config in one place: the concurrency
 * cap, the per-Hall caps and the locked Halls that are skipped.
 */
export function claimLimits(
  config: GuildConfig
): Required<Pick<ClaimOptions, 'maxActive' | 'hallCaps' | 'skipHalls'>> {
  return {
    maxActive: questConcurrency(config),
    hallCaps: hallCaps(config),
    skipHalls: lockedHallIds(config),
  }
}
