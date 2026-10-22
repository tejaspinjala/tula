/**
 * The pure drawing decisions of the three-quarter world (ADR-0016): which sprite goes where and in
 * front of what. Phaser only places what this returns. No Phaser here.
 */
import { DEPTH, type Furniture, type Room } from './room'

/** The size of one atlas frame, in px. */
export interface FrameSize {
  w: number
  h: number
}
/** The frame sizes of both atlases, by frame name. */
export interface Atlases {
  interiors: Record<string, FrameSize>
  furniture: Record<string, FrameSize>
}
/** One sprite to draw: an atlas frame with its top-left corner in room px and a depth. */
export interface Sprite {
  atlas: 'interiors' | 'furniture'
  frame: string
  x: number
  y: number
  depth: number
}
/** A rectangle of the screen in px. */
export interface Viewport {
  x: number
  y: number
  w: number
  h: number
}

const TILE = 16
/** The shadow frame is 16x8; half of it sits under the feet, half in front. */
const SHADOW_HEIGHT = 8

/** The depth of anything standing on `footY` px: further south draws in front. */
export function actorDepth(footY: number): number {
  return DEPTH.actor + footY
}

/** The shadow sprite under a character whose feet are at `foot` px (a 16x8 frame). */
export function actorShadow(foot: { x: number; y: number }): Sprite {
  return {
    atlas: 'furniture',
    frame: 'shadow',
    x: foot.x - TILE / 2,
    y: foot.y - SHADOW_HEIGHT / 2,
    depth: DEPTH.shadow,
  }
}

/** True when open floor lies directly north of the piece, so it stands free and casts a shadow. */
export function freeStanding(room: Room, piece: Furniture): boolean {
  const { x, y, w } = piece.tile
  return Array.from({ length: w }, (_v, i) => room.walkable(x + i, y - 1)).some(Boolean)
}

/** Decor that lies on the floor (rugs, mats) rather than hangs on a wall. */
const onFloor = (frame: string) => frame.startsWith('rug-') || frame === 'door-mat'

/** Every sprite of a room: floor, walls, decor, furniture bases and tops, and free-standing shadows. */
export function roomSprites(room: Room, atlases: Atlases): Sprite[] {
  const out: Sprite[] = []
  const layer = (cells: (string | null)[], depth: (frame: string) => number) => {
    cells.forEach((frame, i) => {
      if (frame !== null) {
        out.push({
          atlas: 'interiors',
          frame,
          x: (i % room.width) * TILE,
          y: Math.floor(i / room.width) * TILE,
          depth: depth(frame),
        })
      }
    })
  }
  layer(room.layers.floor, () => DEPTH.floor)
  layer(room.layers.wallFace, () => DEPTH.wall)
  layer(room.layers.wallTop, () => DEPTH.wall)
  layer(room.layers.decor, (f) => (onFloor(f) ? DEPTH.floor + 1 : DEPTH.wall + 1))
  for (const piece of room.furniture) {
    const key = actorDepth(piece.depth * TILE)
    const base = atlases.furniture[piece.frame] ?? { w: TILE, h: TILE }
    const baseY = (piece.tile.y + piece.tile.h) * TILE - base.h
    out.push({
      atlas: 'furniture',
      frame: piece.frame,
      x: piece.tile.x * TILE,
      y: baseY,
      depth: key,
    })
    const top = atlases.furniture[`${piece.frame}~top`]
    if (piece.top && top) {
      out.push({
        atlas: 'furniture',
        frame: `${piece.frame}~top`,
        x: piece.tile.x * TILE,
        y: baseY - top.h,
        depth: key + 0.5,
      })
    }
    if (freeStanding(room, piece)) {
      for (let i = 0; i < piece.tile.w; i++) {
        out.push(
          actorShadow({
            x: (piece.tile.x + i) * TILE + TILE / 2,
            y: (piece.tile.y + piece.tile.h) * TILE,
          })
        )
      }
    }
  }
  return out
}

/** The part of the screen the camera draws in: everything below the reserved HUD strip. */
export function viewportFor(screen: { w: number; h: number }, hudHeight: number): Viewport {
  const y = Math.min(Math.max(0, Math.round(hudHeight)), screen.h)
  return { x: 0, y, w: screen.w, h: screen.h - y }
}
