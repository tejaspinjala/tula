import { z } from 'zod'
import { type LookChoice, lookChoice } from '../game/look'

const agent = z.object({ id: z.string(), name: z.string() })
const member = agent.extend({
  rank: z.enum(['apprentice', 'journeyman', 'adept']),
  look: lookChoice.optional(),
})
const hall = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['work', 'private']),
  locked: z.boolean(),
  privateEligible: z.boolean(),
  captain: agent.nullable(),
  members: z.array(member),
  maxConcurrentMembers: z.number().int().optional(),
})
const guildCaps = z.looseObject({
  maxChildrenPerQuest: z.number().int().optional(),
  maxSpawnDepth: z.number().int().optional(),
  maxQuestsPerCampaign: z.number().int().optional(),
  maxInquiriesPerQuest: z.number().int().optional(),
  maxBugReportsPerQuest: z.number().int().optional(),
  maxDossiersPerQuest: z.number().int().optional(),
})
const config = z.looseObject({
  steward: agent,
  halls: z.array(hall),
  caps: guildCaps.optional(),
})

/** One Member of a Hall. */
export type BuilderMember = z.infer<typeof member>
/** One Hall of the config as the builder edits it. */
export type BuilderHall = z.infer<typeof hall>
/** A guild config as the builder edits it: Halls and Members typed, every other key carried untouched. */
export type BuilderConfig = z.infer<typeof config>

/** Parses a config document from the server. */
export function parseConfig(value: unknown): BuilderConfig {
  return config.parse(value)
}

/** Where a moved Member lands: a Hall, optionally before another Member. */
export interface MoveTarget {
  hallId: string
  before?: string
}

/** The save status line of the Guild builder. */
export function saveStatus(dirty: boolean, pending: boolean): string {
  if (pending) {
    return 'Saved, waiting for your passkey to confirm'
  }
  return dirty ? 'Unsaved changes' : 'No unsaved changes'
}

/** Every id in use (Steward, Halls, Captains, Members), so a new one never clashes. */
export function usedIds(c: BuilderConfig): Set<string> {
  const ids = new Set<string>([c.steward.id])
  for (const h of c.halls) {
    ids.add(h.id)
    if (h.captain) {
      ids.add(h.captain.id)
    }
    for (const m of h.members) {
      ids.add(m.id)
    }
  }
  return ids
}

/** The first of `base`, `base-2`, `base-3`... that is not in `taken`, as a valid id slug. */
export function freshId(base: string, taken: Set<string>): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
  const stem = (slug || 'item').slice(0, 56)
  if (!taken.has(stem)) {
    return stem
  }
  for (let n = 2; ; n++) {
    if (!taken.has(`${stem}-${n}`)) {
      return `${stem}-${n}`
    }
  }
}

/** Moves a Member to a Hall (last, or before another Member). An unknown Hall or Member changes nothing. */
export function moveMember(c: BuilderConfig, id: string, to: MoveTarget): BuilderConfig {
  const moving = c.halls.flatMap((h) => h.members).find((m) => m.id === id)
  if (!moving || !c.halls.some((h) => h.id === to.hallId) || to.before === id) {
    return c
  }
  return {
    ...c,
    halls: c.halls.map((h) => {
      const rest = h.members.filter((m) => m.id !== id)
      if (h.id !== to.hallId) {
        return { ...h, members: rest }
      }
      const at = to.before === undefined ? -1 : rest.findIndex((m) => m.id === to.before)
      return {
        ...h,
        members: at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)],
      }
    }),
  }
}

/** Adds a blank work Hall. */
export function addHall(c: BuilderConfig, name: string): BuilderConfig {
  const added: BuilderHall = {
    id: freshId(name, usedIds(c)),
    name,
    kind: 'work',
    locked: false,
    privateEligible: false,
    captain: null,
    members: [],
  }
  return { ...c, halls: [...c.halls, added] }
}

/** Adds a blank apprentice Member to a Hall. */
export function addMember(c: BuilderConfig, hallId: string): BuilderConfig {
  const id = freshId('member', usedIds(c))
  return {
    ...c,
    halls: c.halls.map((h) =>
      h.id === hallId
        ? { ...h, members: [...h.members, { id, name: 'New Member', rank: 'apprentice' as const }] }
        : h
    ),
  }
}

/** Deletes a Hall (and with it its Captain and Members). */
export function deleteHall(c: BuilderConfig, hallId: string): BuilderConfig {
  return { ...c, halls: c.halls.filter((h) => h.id !== hallId) }
}

/** Deletes one Member. */
export function deleteMember(c: BuilderConfig, id: string): BuilderConfig {
  return {
    ...c,
    halls: c.halls.map((h) => ({ ...h, members: h.members.filter((m) => m.id !== id) })),
  }
}

/** Renames a Hall, its Captain or a Member by id. */
export function rename(c: BuilderConfig, id: string, name: string): BuilderConfig {
  return {
    ...c,
    halls: c.halls.map((h) => ({
      ...h,
      name: h.id === id ? name : h.name,
      captain: h.captain && h.captain.id === id ? { ...h.captain, name } : h.captain,
      members: h.members.map((m) => (m.id === id ? { ...m, name } : m)),
    })),
  }
}

/** Sets a Member's rank. */
export function setRank(c: BuilderConfig, id: string, rank: BuilderMember['rank']): BuilderConfig {
  return {
    ...c,
    halls: c.halls.map((h) => ({
      ...h,
      members: h.members.map((m) => (m.id === id ? { ...m, rank } : m)),
    })),
  }
}

/** Sets a Member's look override, or clears it with null (back to the look its id seeds). */
export function setLook(c: BuilderConfig, id: string, look: LookChoice | null): BuilderConfig {
  return {
    ...c,
    halls: c.halls.map((h) => ({
      ...h,
      members: h.members.map((m) => {
        if (m.id !== id) {
          return m
        }
        const { look: _previous, ...rest } = m
        return look ? { ...rest, look } : rest
      }),
    })),
  }
}

/** Sets one Hall's settings (locked, private eligibility). */
export function setHallSettings(
  c: BuilderConfig,
  hallId: string,
  settings: Partial<Pick<BuilderHall, 'locked' | 'privateEligible'>>
): BuilderConfig {
  return { ...c, halls: c.halls.map((h) => (h.id === hallId ? { ...h, ...settings } : h)) }
}

/** Gives a Hall a Captain (renaming the current one), or none. */
export function setCaptain(c: BuilderConfig, hallId: string, name: string | null): BuilderConfig {
  const fresh = freshId(`${hallId}-captain`, usedIds(c))
  return {
    ...c,
    halls: c.halls.map((h) =>
      h.id === hallId
        ? { ...h, captain: name === null ? null : { id: h.captain?.id ?? fresh, name } }
        : h
    ),
  }
}
