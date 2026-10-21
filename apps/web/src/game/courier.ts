import type { HallLayout } from './layout'

/** A point on the hall map, in pixels. */
export interface CourierPoint {
  x: number
  y: number
}

const middle = (
  layout: HallLayout,
  r: { x: number; y: number; w: number; h: number }
): CourierPoint => ({
  x: (r.x + r.w / 2) * layout.tileSize,
  y: (r.y + r.h / 2) * layout.tileSize,
})

/**
 * The way a courier walks from one room to another: out of the source room's door, along the
 * hallway, and to the target room's door, where the letter is handed in. It never crosses a room,
 * so the HUD over the top rooms never hides it. Null when either room is not on the map (or they
 * are one).
 */
export function courierRoute(
  layout: HallLayout,
  fromRoom: number,
  toRoom: number
): CourierPoint[] | null {
  const fromDoor = layout.doorways[fromRoom]
  const toDoor = layout.doorways[toRoom]
  if (
    fromRoom === toRoom ||
    !layout.rooms[fromRoom] ||
    !layout.rooms[toRoom] ||
    !fromDoor ||
    !toDoor
  ) {
    return null
  }
  // The hallway row just outside a door: below the top rooms' doors, above the bottom rooms'.
  const outside = (door: typeof fromDoor): CourierPoint => {
    const at = middle(layout, door)
    const step = door.y < layout.height / 2 ? layout.tileSize : -layout.tileSize
    return { x: at.x, y: at.y + step }
  }
  return [middle(layout, fromDoor), outside(fromDoor), outside(toDoor), middle(layout, toDoor)]
}
