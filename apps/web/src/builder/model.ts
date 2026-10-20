import { z } from 'zod'

const agent = z.object({ id: z.string(), name: z.string() })
const member = agent.extend({ rank: z.enum(['apprentice', 'journeyman', 'adept']) })
const hall = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['work', 'private']),
  locked: z.boolean(),
  privateEligible: z.boolean(),
  captain: agent.nullable(),
  members: z.array(member),
})
const config = z.looseObject({ steward: agent, halls: z.array(hall) })

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

function todo(): never {
  throw new Error('not implemented')
}

/** Moves a Member to a Hall (last, or before another Member). */
export function moveMember(_c: BuilderConfig, _id: string, _to: MoveTarget): BuilderConfig {
  return todo()
}
/** Adds a blank work Hall. */
export function addHall(_c: BuilderConfig, _name: string): BuilderConfig {
  return todo()
}
/** Adds a blank apprentice Member to a Hall. */
export function addMember(_c: BuilderConfig, _hallId: string): BuilderConfig {
  return todo()
}
/** Deletes a Hall. */
export function deleteHall(_c: BuilderConfig, _hallId: string): BuilderConfig {
  return todo()
}
