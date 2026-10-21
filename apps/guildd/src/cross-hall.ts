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
  /** `push`: data flows from the source to the target; `pull`: data flows from the target back to the source. */
  flow: 'push' | 'pull'
  /** For `pull`: the data class of the subject held by the target. */
  subjectDataClass?: DataClass | undefined
  halls: readonly CrossHallHall[]
  sourceHall: string
  sourceDataClass: DataClass
  toHall: string
  toMember?: string | undefined
}

/**
 * The one cross-Hall addressing rule. Resolves the target Hall (and optional Member) among the
 * caller guild's Halls, so another guild's Hall is indistinguishable from an unknown one, then
 * applies the private boundary by direction. `push` (data flows source to target): a private source
 * Hall or a private-class Quest may not reach a work Hall. `pull` (data flows back from the target
 * to the source): a private target Hall or private subject data may not reach a source that is
 * neither in a private Hall nor a private-class Quest. Deterministic, never a model decision.
 */
export function resolveCrossHall(input: CrossHallInput): CrossHallResolution {
  const source = input.halls.find((h) => h.id === input.sourceHall)
  const target = input.halls.find((h) => h.id === input.toHall)
  if (!source || !target) {
    return { ok: false, error: 'unknown_hall' }
  }
  if (source.id === target.id) {
    return { ok: false, error: 'same_hall' }
  }
  const sourceIsPrivate = source.kind === 'private' || input.sourceDataClass === 'private'
  if (input.flow === 'push') {
    if (target.kind === 'work' && sourceIsPrivate) {
      return { ok: false, error: 'private_boundary' }
    }
  } else if (
    (target.kind === 'private' || input.subjectDataClass === 'private') &&
    !sourceIsPrivate
  ) {
    return { ok: false, error: 'private_boundary' }
  }
  if (input.toMember === undefined) {
    return { ok: true, hall: target, member: null }
  }
  const member = target.members.find((m) => m.id === input.toMember)
  return member ? { ok: true, hall: target, member } : { ok: false, error: 'not_in_hall' }
}
