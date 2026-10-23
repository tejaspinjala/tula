/** What the scene draws for one room slot: its label, how dark its veil is, and whether its door is shut. */
export interface RoomTag {
  text: string
  veil: number
  closed: boolean
  /** True for an unlocked private room: it wears a small privacy mark. */
  privateMark: boolean
  /** How much warm light a lived-in room gets, 0 to 1. */
  warmth: number
}

/** The label, veil and door of each of `slots` room slots, from the Halls in roster order. */
export function roomTags(
  halls: readonly { name: string; locked: boolean; paused: boolean; kind: 'work' | 'private' }[],
  slots: number
): RoomTag[] {
  return Array.from({ length: Math.max(slots, halls.length) }, (_slot, index): RoomTag => {
    const hall = halls[index]
    if (!hall) {
      return { text: 'Locked room', veil: 0.45, closed: true, privateMark: false, warmth: 0 }
    }
    const text = hall.locked
      ? `${hall.name} (locked)`
      : hall.paused
        ? `${hall.name} (paused)`
        : hall.name
    return {
      text: text.slice(0, 22),
      veil: hall.locked ? 0.6 : hall.paused ? 0.35 : 0,
      closed: hall.locked,
      privateMark: hall.kind === 'private' && !hall.locked,
      warmth: hall.kind === 'private' && !hall.locked ? 0.18 : 0,
    }
  })
}

/**
 * Where a speech bubble of `width` px centres horizontally for a speaker at `x`, kept inside the
 * camera `view` (a narrow screen would otherwise clip it at the edge). A bubble wider than the
 * view centres on the view.
 */
export function bubbleCentreX(
  view: { x: number; width: number },
  width: number,
  x: number
): number {
  const half = width / 2 + 1
  if (width + 2 >= view.width) {
    return view.x + view.width / 2
  }
  return Math.min(Math.max(x, view.x + half), view.x + view.width - half)
}
