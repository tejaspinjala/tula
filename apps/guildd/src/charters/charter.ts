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
export const CONFIG_FIELD_CLASS: Record<string, FieldClass> = {
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
}

/** Classification of every Hall key; `privateEligible` is an attestation and stays local. */
export const HALL_FIELD_CLASS: Record<string, FieldClass> = {
  id: 'structure',
  name: 'structure',
  kind: 'structure',
  locked: 'structure',
  privateEligible: 'local',
  captain: 'structure',
  members: 'structure',
  maxConcurrentMembers: 'structure',
}

/** Classification of every provider key; `privateEligible` is an attestation and stays local. */
export const PROVIDER_FIELD_CLASS: Record<string, FieldClass> = {
  id: 'structure',
  auth: 'structure',
  privateEligible: 'local',
}

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

/**
 * Builds a Charter from a guild: every `privateEligible` becomes false, `learningRepos` is dropped,
 * and Rites that are archived, unpublished or touch a private Hall are left out. Each removal is
 * listed in `omitted`.
 */
export function exportCharter(input: {
  name: string
  config: GuildConfig
  rites: ExportRite[]
  now: Date
}): Charter {
  const { learningRepos, ...rest } = input.config
  const config: GuildConfig = {
    ...rest,
    halls: rest.halls.map((h) => ({ ...h, privateEligible: false })),
    providers: rest.providers.map((p) => ({ ...p, privateEligible: false })),
  }
  const omitted: Charter['omitted'] = []
  if (learningRepos !== undefined) {
    omitted.push({ kind: 'config', id: 'learningRepos', reason: 'local' })
  }
  const hallKind = new Map(input.config.halls.map((h) => [h.id, h.kind]))
  const rites: Charter['rites'] = []
  for (const r of input.rites) {
    const reason = omitReason(r, hallKind)
    if (reason !== null || r.activeGraph === null) {
      omitted.push({ kind: 'rite', id: r.id, reason: reason ?? 'unpublished' })
    } else {
      rites.push({ name: r.name, graph: r.activeGraph })
    }
  }
  return {
    charter: 1,
    name: input.name,
    exportedAt: input.now.toISOString(),
    config,
    rites,
    omitted,
  }
}

function omitReason(r: ExportRite, hallKind: Map<string, 'work' | 'private'>): string | null {
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
  return kinds.includes(undefined) ? 'unknown_hall' : null
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
}): ApplyResult {
  const valid = charterSchema.safeParse(input.charter)
  if (!valid.success) {
    return { ok: false, error: 'invalid_charter', message: valid.error.message }
  }
  const charter = valid.data
  const heldHalls = new Map(input.current.halls.map((h) => [h.id, h.privateEligible]))
  const heldProviders = new Map(input.current.providers.map((p) => [p.id, p.privateEligible]))
  const { learningRepos, ...rest } = charter.config
  void learningRepos
  const config: GuildConfig = {
    ...rest,
    halls: rest.halls.map((h) => ({ ...h, privateEligible: heldHalls.get(h.id) ?? false })),
    providers: rest.providers.map((p) => ({
      ...p,
      privateEligible: heldProviders.get(p.id) ?? false,
    })),
    ...(input.current.learningRepos === undefined
      ? {}
      : { learningRepos: input.current.learningRepos }),
  }
  const hallIds = new Set(config.halls.map((h) => h.id))
  for (const r of charter.rites) {
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
