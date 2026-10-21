import type { DataClass } from './ports/quest-queue'

/** The slice of a configured Hall the cross-Hall rule needs. */
export interface CrossHallHall {
  id: string
  kind: 'work' | 'private'
  members: { id: string }[]
}

/** Why a cross-Hall target was refused. */
export type CrossHallRefusal = 'unknown_hall' | 'not_in_hall' | 'same_hall' | 'private_boundary'

/** The outcome of resolving a cross-Hall target. */
export type CrossHallResolution =
  | { ok: true; hall: CrossHallHall; member: { id: string } | null }
  | { ok: false; error: CrossHallRefusal }

/** Inputs to {@link resolveCrossHall}; `halls` is the caller guild's Halls, so other guilds' Halls never resolve. */
export interface CrossHallInput {
  halls: readonly CrossHallHall[]
  sourceHall: string
  sourceDataClass: DataClass
  toHall: string
  toMember?: string | undefined
}

/** Resolves a cross-Hall target inside the caller's guild and applies the private boundary (stub). */
export function resolveCrossHall(_input: CrossHallInput): CrossHallResolution {
  return { ok: false, error: 'unknown_hall' }
}
