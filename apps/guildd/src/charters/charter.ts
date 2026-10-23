import { z } from 'zod'
import { type GuildConfig, guildConfig } from '../guild-config'
import { type RiteGraph, riteGraph } from '../rites/graph'

/** Largest Charter document, in bytes. */
export const CHARTER_MAX_BYTES = 256 * 1024

/** Most Rites one Charter may carry. */
export const CHARTER_MAX_RITES = 50

/** How a config key travels in a Charter: `structure` is exported, `local` stays with the guild. */
export type FieldClass = 'structure' | 'local'

/** Classification of every top-level `guildConfig` key; a test fails when a key is missing here. */
export const CONFIG_FIELD_CLASS = {
  steward: 'structure',
  halls: 'structure',
  sealPolicy: 'structure',
  caps: 'structure',
  providers: 'structure',
  routingProfiles: 'structure',
  schedules: 'structure',
  tripwires: 'structure',
  treasury: 'structure',
  learningRepos: 'local',
  contentPolicy: 'structure',
} as const satisfies Record<string, FieldClass>

/** Classification of every Hall key; `privateEligible` is an attestation and stays local. */
export const HALL_FIELD_CLASS = {
  id: 'structure',
  name: 'structure',
  kind: 'structure',
  locked: 'structure',
  privateEligible: 'local',
  captain: 'structure',
  members: 'structure',
  roomStyle: 'structure',
  maxConcurrentMembers: 'structure',
} as const satisfies Record<string, FieldClass>

/** Classification of every provider key; `privateEligible` is an attestation and stays local. */
export const PROVIDER_FIELD_CLASS = {
  id: 'structure',
  auth: 'structure',
  privateEligible: 'local',
} as const satisfies Record<string, FieldClass>

/** Nested objects hold only structure: every key is classified so a new one must be reviewed. */
export const MEMBER_FIELD_CLASS = {
  id: 'structure',
  name: 'structure',
  rank: 'structure',
  look: 'structure',
} as const satisfies Record<string, FieldClass>
/** Keys of an agent (the Steward and every Captain). */
export const AGENT_FIELD_CLASS = {
  id: 'structure',
  name: 'structure',
} as const satisfies Record<string, FieldClass>
/** Keys of the guild caps. */
export const CAPS_FIELD_CLASS = {
  dailyTokens: 'structure',
  dailySpendCents: 'structure',
  concurrentQuests: 'structure',
  sealPostWindowHours: 'structure',
  maxChildrenPerQuest: 'structure',
  maxSpawnDepth: 'structure',
  maxQuestsPerCampaign: 'structure',
  maxMissivesPerQuest: 'structure',
  maxResearchPerQuest: 'structure',
  maxInquiriesPerQuest: 'structure',
  maxBugReportsPerQuest: 'structure',
  maxDossiersPerQuest: 'structure',
  maxCouncilApprovalsPerDay: 'structure',
  maxCouncilSessionsPerDay: 'structure',
} as const satisfies Record<string, FieldClass>
/** Keys of the Treasury envelope. */
export const TREASURY_FIELD_CLASS = {
  dailyCapCents: 'structure',
  treasurerLimitCents: 'structure',
  reservePercent: 'structure',
  reinvestPercent: 'structure',
} as const satisfies Record<string, FieldClass>
/** Keys of the Tripwire thresholds. */
export const TRIPWIRES_FIELD_CLASS = {
  tokenBurnMultiple: 'structure',
  gateDenialsPerHour: 'structure',
  loopRepeats: 'structure',
} as const satisfies Record<string, FieldClass>
/** Keys of the content policy. */
export const CONTENT_POLICY_FIELD_CLASS = {
  maxLength: 'structure',
  bannedTerms: 'structure',
  requiredTerms: 'structure',
  allowMetaDrafts: 'structure',
} as const satisfies Record<string, FieldClass>
/** Keys of a routing profile. */
export const ROUTING_PROFILE_FIELD_CLASS = {
  id: 'structure',
  provider: 'structure',
  tier: 'structure',
  model: 'structure',
  price: 'structure',
} as const satisfies Record<string, FieldClass>
/** Keys of a schedule. */
export const SCHEDULE_FIELD_CLASS = {
  id: 'structure',
  cron: 'structure',
} as const satisfies Record<string, FieldClass>

/** The Charter document (ADR-0014): guild structure only, never attestations or private data. */
export const charterSchema = z.strictObject({
  charter: z.literal(1),
  name: z.string().trim().min(1).max(100),
  exportedAt: z.iso.datetime(),
  config: guildConfig,
  rites: z
    .array(z.strictObject({ name: z.string().trim().min(1).max(200), graph: riteGraph }))
    .max(CHARTER_MAX_RITES),
  omitted: z
    .array(
      z.strictObject({
        kind: z.string().max(40),
        id: z.string().max(200),
        reason: z.string().max(80),
      })
    )
    .max(1000),
})
/** A Charter document. */
export type Charter = z.infer<typeof charterSchema>

/** The outcome of {@link parseCharter}. */
export type ParseResult =
  | { ok: true; charter: Charter }
  | { ok: false; error: 'invalid_charter'; message: string }

/** Parses Charter text, refusing one over {@link CHARTER_MAX_BYTES} or not matching the schema. */
export function parseCharter(text: string): ParseResult {
  if (new TextEncoder().encode(text).length > CHARTER_MAX_BYTES) {
    return { ok: false, error: 'invalid_charter', message: 'charter exceeds the size limit' }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid_charter', message: 'charter is not valid JSON' }
  }
  const parsed = charterSchema.safeParse(json)
  return parsed.success
    ? { ok: true, charter: parsed.data }
    : { ok: false, error: 'invalid_charter', message: parsed.error.message }
}

/** A Rite as the exporter sees it. */
export interface ExportRite {
  id: string
  name: string
  archivedAt: string | null
  /** The graph of the active version, or null when none is active. */
  activeGraph: RiteGraph | null
}

function nodeHallIds(graph: RiteGraph): string[] {
  return graph.nodes.flatMap((n) => ('hallId' in n ? [n.hallId] : []))
}

type Plain = Record<string, unknown>

/** The three tables that drive export and apply. */
export interface FieldTables {
  config: Readonly<Record<string, FieldClass>>
  hall: Readonly<Record<string, FieldClass>>
  provider: Readonly<Record<string, FieldClass>>
}

/** The tables export and apply use unless the caller passes its own. */
export const DEFAULT_FIELD_TABLES: FieldTables = {
  config: CONFIG_FIELD_CLASS,
  hall: HALL_FIELD_CLASS,
  provider: PROVIDER_FIELD_CLASS,
}

/** Export side of a table: a `local` boolean becomes false, any other `local` key is dropped. */
function resetLocal(obj: Plain, table: Readonly<Record<string, FieldClass>>): Plain {
  return Object.fromEntries(
    Object.entries(obj).flatMap(([k, v]): [string, unknown][] => {
      if (table[k] !== 'local') {
        return [[k, v]]
      }
      return typeof v === 'boolean' ? [[k, false]] : []
    })
  )
}

/** One omitted entry for each `local` boolean that was true on an item and export reset to false. */
function resetFlags(
  list: string,
  items: readonly ({ id: string } & Plain)[],
  table: Readonly<Record<string, FieldClass>>
): Charter['omitted'] {
  return items.flatMap((item) =>
    Object.entries(table)
      .filter(([k, cls]) => cls === 'local' && item[k] === true)
      .map(([k]) => ({ kind: 'config', id: `${list}.${item.id}.${k}`, reason: 'local' }))
  )
}

/** Apply side of a table: every `local` key comes from `held` (the current object); a missing boolean is false. */
function takeLocal(
  obj: Plain,
  table: Readonly<Record<string, FieldClass>>,
  held: Plain | undefined
): Plain {
  const out: Plain = Object.fromEntries(Object.entries(obj).filter(([k]) => table[k] !== 'local'))
  for (const [k, cls] of Object.entries(table)) {
    if (cls !== 'local') {
      continue
    }
    const mine = held?.[k]
    if (typeof mine === 'boolean' || typeof obj[k] === 'boolean') {
      out[k] = mine === true
    } else if (mine !== undefined) {
      out[k] = mine
    }
  }
  return out
}

/**
 * Builds a Charter from a guild: every `local` key is dropped (booleans become false) and Rites
 * that are archived, unpublished or touch a private Hall are left out. Each removal is listed in
 * `omitted`. The result is parsed strictly, so an unexpected runtime key fails closed.
 */
export function exportCharter(input: {
  name: string
  config: GuildConfig
  rites: ExportRite[]
  now: Date
  /** Defaults to {@link DEFAULT_FIELD_TABLES}. */
  tables?: FieldTables
}): Charter {
  const t = input.tables ?? DEFAULT_FIELD_TABLES
  const source: Plain = input.config
  const config = {
    ...resetLocal(source, t.config),
    halls: input.config.halls.map((h) => resetLocal(h, t.hall)),
    providers: input.config.providers.map((p) => resetLocal(p, t.provider)),
  }
  const omitted: Charter['omitted'] = Object.entries(t.config)
    .filter(
      ([k, cls]) => cls === 'local' && source[k] !== undefined && typeof source[k] !== 'boolean'
    )
    .map(([k]) => ({ kind: 'config', id: k, reason: 'local' }))
  omitted.push(
    ...resetFlags('halls', input.config.halls, t.hall),
    ...resetFlags('providers', input.config.providers, t.provider)
  )
  const hallKind = new Map(input.config.halls.map((h) => [h.id, h.kind]))
  const scheduleIds = new Set(input.config.schedules.map((x) => x.id))
  const rites: { name: string; graph: RiteGraph }[] = []
  const exportable: { id: string; name: string; graph: RiteGraph }[] = []
  for (const r of input.rites) {
    const reason = omitReason(r, hallKind, scheduleIds)
    if (reason !== null || r.activeGraph === null) {
      omitted.push({ kind: 'rite', id: r.id, reason: reason ?? 'unpublished' })
    } else {
      exportable.push({ id: r.id, name: r.name, graph: r.activeGraph })
    }
  }
  // A stable order (name, then id) makes the cut at the limit deterministic.
  const byNameThenId = (a: { id: string; name: string }, b: { id: string; name: string }) =>
    a.name === b.name ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.name < b.name ? -1 : 1
  exportable.sort(byNameThenId)
  for (const [i, r] of exportable.entries()) {
    if (i < CHARTER_MAX_RITES) {
      rites.push({ name: r.name, graph: r.graph })
    } else {
      omitted.push({ kind: 'rite', id: r.id, reason: 'over_limit' })
    }
  }
  return charterSchema.parse({
    charter: 1,
    name: input.name,
    exportedAt: input.now.toISOString(),
    config,
    rites,
    omitted,
  })
}

function omitReason(
  r: ExportRite,
  hallKind: Map<string, 'work' | 'private'>,
  scheduleIds: Set<string>
): string | null {
  if (r.archivedAt !== null) {
    return 'archived'
  }
  if (r.activeGraph === null) {
    return 'unpublished'
  }
  const kinds = nodeHallIds(r.activeGraph).map((id) => hallKind.get(id))
  if (kinds.includes('private')) {
    return 'private_hall'
  }
  if (kinds.includes(undefined)) {
    return 'unknown_hall'
  }
  const unknownSchedule = r.activeGraph.nodes.some(
    (n) => n.type === 'trigger.schedule' && !scheduleIds.has(n.scheduleId)
  )
  return unknownSchedule ? 'unknown_schedule' : null
}

/** The outcome of {@link applyCharter}. */
export type ApplyResult =
  | { ok: true; config: GuildConfig; drafts: { name: string; graph: RiteGraph }[] }
  | { ok: false; error: 'invalid_charter'; message: string }

const MAX_RITE_NAME = 200

function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    return base
  }
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`
    const candidate = `${base.slice(0, MAX_RITE_NAME - suffix.length)}${suffix}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
}

/**
 * Turns a Charter into a proposed config and Rite drafts. Importing grants no authority: the
 * config still goes through propose/confirm and Rites land as drafts. Local fields come from
 * `current` (`learningRepos`, and `privateEligible` for ids present in both); new ids get false.
 */
export function applyCharter(input: {
  charter: Charter
  current: GuildConfig
  existingRiteNames: string[]
  /** Defaults to {@link DEFAULT_FIELD_TABLES}. */
  tables?: FieldTables
}): ApplyResult {
  const t = input.tables ?? DEFAULT_FIELD_TABLES
  const valid = charterSchema.safeParse(input.charter)
  if (!valid.success) {
    return { ok: false, error: 'invalid_charter', message: valid.error.message }
  }
  const charter = valid.data
  const heldConfig: Plain = input.current
  const byId = (list: { id: string }[]) => new Map(list.map((x): [string, Plain] => [x.id, x]))
  const heldHalls = byId(input.current.halls)
  const heldProviders = byId(input.current.providers)
  const candidate = guildConfig.safeParse({
    ...takeLocal(charter.config, t.config, heldConfig),
    halls: charter.config.halls.map((h) => takeLocal(h, t.hall, heldHalls.get(h.id))),
    providers: charter.config.providers.map((p) =>
      takeLocal(p, t.provider, heldProviders.get(p.id))
    ),
  })
  if (!candidate.success) {
    return { ok: false, error: 'invalid_charter', message: candidate.error.message }
  }
  const config = candidate.data
  const hallIds = new Set(config.halls.map((h) => h.id))
  const scheduleIds = new Set(config.schedules.map((x) => x.id))
  for (const r of charter.rites) {
    const noSchedule = r.graph.nodes.find(
      (n) => n.type === 'trigger.schedule' && !scheduleIds.has(n.scheduleId)
    )
    if (noSchedule !== undefined) {
      return {
        ok: false,
        error: 'invalid_charter',
        message: `rite "${r.name}" names a schedule the charter config does not define`,
      }
    }
    const missing = nodeHallIds(r.graph).find((id) => !hallIds.has(id))
    if (missing !== undefined) {
      return {
        ok: false,
        error: 'invalid_charter',
        message: `rite "${r.name}" names Hall "${missing}", which the charter config does not define`,
      }
    }
  }
  const taken = new Set(input.existingRiteNames)
  const drafts = charter.rites.map((r) => {
    const name = freeName(r.name, taken)
    taken.add(name)
    return { name, graph: r.graph }
  })
  return { ok: true, config, drafts }
}
