/** A point in world pixels. */
export interface Px {
  x: number
  y: number
}

/** How far, in px, a Member steps aside from the Guild Master. */
export const ASIDE_PX = 10

/**
 * Where a Member should be drawn so they do not stand on top of the Guild Master: unchanged when
 * clear, otherwise nudged sideways (away from the Guild Master, or right on an exact overlap).
 */
export function stepAside(member: Px, guildMaster: Px): Px {
  const dx = member.x - guildMaster.x
  if (Math.abs(dx) >= ASIDE_PX || Math.abs(member.y - guildMaster.y) >= ASIDE_PX) {
    return member
  }
  return { x: guildMaster.x + (dx < 0 ? -ASIDE_PX : ASIDE_PX), y: member.y }
}
