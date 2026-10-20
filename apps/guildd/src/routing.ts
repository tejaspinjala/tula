import type { GuildConfig } from './guild-config'
import type { DataClass } from './ports/classifier'
import { type Classifier, DATA_CLASSES } from './ports/classifier'
import type { BlockReason, RoutingEntry, RoutingLog } from './ports/routing-log'

type Rank = GuildConfig['halls'][number]['members'][number]['rank']
type Tier = GuildConfig['routingProfiles'][number]['tier']
type Hall = GuildConfig['halls'][number]
type Provider = GuildConfig['providers'][number]

/** Member rank to model tier; the tier names a routing profile, never a model id. */
const TIER_OF_RANK: Record<Rank, Tier> = { apprentice: 'cheap', journeyman: 'mid', adept: 'deep' }
const TIERS: readonly Tier[] = ['cheap', 'mid', 'deep']

/** What the Quest brings: a template's data, or a free-text goal for the classifier. */
export type RouteWork =
  | { kind: 'template'; hallId: string; rank: Rank; dataClass: DataClass }
  | { kind: 'free_text'; goal: string }

/** Remaining allowance of one provider; dollars apply only to `api_key` providers (ADR-0005). */
export interface ProviderBudget {
  tokensRemaining: number
  centsRemaining: number
}

/** Everything {@link route} needs; all of it data, nothing read from process memory. */
export interface RouteInput {
  guildId: string
  /** Idempotency key for the decision log, e.g. Quest id plus attempt. */
  decisionKey: string
  /** The guild's config in force (`ConfigStore.current`). */
  config: GuildConfig
  work: RouteWork
  /** Remaining budget per provider id; a provider with no entry counts as out of budget. */
  budgets: Readonly<Record<string, ProviderBudget>>
  /** Provider ids currently unavailable. */
  unavailable: readonly string[]
  /** Hosted (v2) deployments reject `subscription` providers (ADR-0005). */
  hosted: boolean
  /** Expected cost of the run, checked against each provider's budget. */
  estimate: { tokens: number; cents: number }
}

/** The ports {@link route} calls. */
export interface RouteDeps {
  classifier: Classifier
  log: RoutingLog
}

/** Where work goes, or why it cannot go anywhere. */
export type RouteOutcome =
  | {
      status: 'routed'
      providerId: string
      profileId: string
      tier: Tier
      hallId: string
      rank: Rank
      dataClass: DataClass
    }
  | { status: 'blocked'; reason: BlockReason }

type Step1 = {
  source: RoutingEntry['source']
  hall: Hall
  rank: Rank
  dataClass: DataClass
  claim: RoutingEntry['classifierClaim']
}

const restriction = (c: DataClass): number => DATA_CLASSES.indexOf(c)
const stricter = (a: DataClass, b: DataClass): DataClass =>
  restriction(a) >= restriction(b) ? a : b
/** The least restrictive class a Hall's work may carry: a private Hall's work is always private. */
const floorOf = (hall: Hall): DataClass => (hall.kind === 'private' ? 'private' : 'public')

function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex')
}

/**
 * Step 1: Hall, rank and data class. A template supplies them as data and the classifier is never
 * called. Only a free-text goal is classified; the answer is untrusted, so it must name an
 * unlocked Hall of this config, and its class is raised to the Hall's floor (it can narrow, never
 * widen). Any failure or invalid answer takes the deterministic fallback: the first unlocked work
 * Hall, apprentice, `internal`.
 */
async function classifyStep(
  input: RouteInput,
  deps: RouteDeps
): Promise<Step1 | { blocked: BlockReason; hallId: string | null; source: Step1['source'] }> {
  const { config, work } = input
  if (work.kind === 'template') {
    const hall = config.halls.find((h) => h.id === work.hallId)
    if (!hall) {
      return { blocked: 'hall_not_found', hallId: work.hallId, source: 'template' }
    }
    if (hall.locked) {
      return { blocked: 'hall_locked', hallId: hall.id, source: 'template' }
    }
    return {
      source: 'template',
      hall,
      rank: work.rank,
      dataClass: stricter(work.dataClass, floorOf(hall)),
      claim: null,
    }
  }
  const open = config.halls.filter((h) => !h.locked)
  let claim: RoutingEntry['classifierClaim'] = null
  try {
    claim = await deps.classifier.classify({
      goal: work.goal,
      halls: open.map((h) => ({ id: h.id, kind: h.kind })),
    })
  } catch {
    claim = null
  }
  const hall = claim ? open.find((h) => h.id === claim?.hallId) : undefined
  if (claim && hall) {
    return {
      source: 'classifier',
      hall,
      rank: claim.rank,
      dataClass: stricter(claim.dataClass, floorOf(hall)),
      claim,
    }
  }
  const fallback = open.find((h) => h.kind === 'work')
  if (!fallback) {
    return { blocked: 'hall_not_found', hallId: null, source: 'fallback' }
  }
  return {
    source: 'fallback',
    hall: fallback,
    rank: 'apprentice',
    dataClass: stricter('internal', floorOf(fallback)),
    claim,
  }
}

const fits = (p: Provider, b: ProviderBudget | undefined, est: RouteInput['estimate']): boolean =>
  b !== undefined &&
  b.tokensRemaining >= est.tokens &&
  (p.auth === 'subscription' || b.centsRemaining >= est.cents)

/**
 * Step 2, pure and deterministic: data class first (private work needs a private-eligible Hall and
 * provider, else it fails closed), then budget, then availability. Failover is the remaining
 * profiles in order of tier distance, already filtered by class and budget. A model never decides.
 */
export function resolve(
  input: RouteInput,
  step: Pick<Step1, 'hall' | 'rank' | 'dataClass'>
): RouteOutcome {
  const private_ = step.dataClass === 'private'
  const none: BlockReason = private_ ? 'private_provider_unavailable' : 'no_provider_available'
  if (private_ && !step.hall.privateEligible) {
    return { status: 'blocked', reason: 'private_provider_unavailable' }
  }
  const providers = new Map(
    input.config.providers
      .filter((p) => !(input.hosted && p.auth === 'subscription'))
      .filter((p) => !private_ || p.privateEligible)
      .map((p) => [p.id, p])
  )
  const wanted = TIERS.indexOf(TIER_OF_RANK[step.rank])
  const ordered = input.config.routingProfiles
    .filter((r) => providers.has(r.provider))
    .map((r, i) => ({ r, i, d: Math.abs(TIERS.indexOf(r.tier) - wanted) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.r)
  if (ordered.length === 0) {
    return { status: 'blocked', reason: none }
  }
  const affordable = ordered.filter((r) => {
    const p = providers.get(r.provider)
    return p !== undefined && fits(p, input.budgets[r.provider], input.estimate)
  })
  if (affordable.length === 0) {
    return { status: 'blocked', reason: 'budget_exhausted' }
  }
  const chosen = affordable.find((r) => !input.unavailable.includes(r.provider))
  if (!chosen) {
    return { status: 'blocked', reason: 'no_provider_available' }
  }
  return {
    status: 'routed',
    providerId: chosen.provider,
    profileId: chosen.id,
    tier: chosen.tier,
    hallId: step.hall.id,
    rank: step.rank,
    dataClass: step.dataClass,
  }
}

/**
 * Routes one Quest's work and logs the decision (ADR-0006): step 1 takes Hall, rank and data class
 * from the template (zero classifier calls) or classifies a free-text goal with a deterministic
 * fallback; step 2 resolves provider and tier by data class, budget, then availability. Private
 * work with no private-eligible provider ends `blocked: private_provider_unavailable`. Retrying
 * with the same `decisionKey` logs once.
 */
export async function route(input: RouteInput, deps: RouteDeps): Promise<RouteOutcome> {
  const step = await classifyStep(input, deps)
  const goalSha256 = input.work.kind === 'free_text' ? sha256(input.work.goal) : null
  const base = { decisionKey: input.decisionKey, goalSha256 }
  if ('blocked' in step) {
    await deps.log.record(input.guildId, {
      ...base,
      source: step.source,
      hallId: step.hallId,
      rank: null,
      dataClass: null,
      classifierClaim: null,
      outcome: 'blocked',
      providerId: null,
      profileId: null,
      reason: step.blocked,
    })
    return { status: 'blocked', reason: step.blocked }
  }
  const outcome = resolve(input, step)
  await deps.log.record(input.guildId, {
    ...base,
    source: step.source,
    hallId: step.hall.id,
    rank: step.rank,
    dataClass: step.dataClass,
    classifierClaim: step.claim,
    outcome: outcome.status,
    providerId: outcome.status === 'routed' ? outcome.providerId : null,
    profileId: outcome.status === 'routed' ? outcome.profileId : null,
    reason: outcome.status === 'blocked' ? outcome.reason : null,
  })
  return outcome
}
