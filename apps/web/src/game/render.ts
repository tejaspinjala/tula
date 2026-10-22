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

/** The depth of anything standing on `footY` px: further south draws in front. */
export function actorDepth(_footY: number): number {
  throw new Error('todo')
}

/** The shadow sprite under a character whose feet are at `foot` px (a 16x8 frame). */
export function actorShadow(_foot: { x: number; y: number }): Sprite {
  throw new Error('todo')
}

/** True when open floor lies directly north of the piece, so it stands free and casts a shadow. */
export function freeStanding(_room: Room, _piece: Furniture): boolean {
  throw new Error('todo')
}

/** Every sprite of a room: floor, walls, decor, furniture bases and tops, and free-standing shadows. */
export function roomSprites(_room: Room, _atlases: Atlases): Sprite[] {
  throw new Error('todo')
}

/** The part of the screen the camera draws in: everything below the reserved HUD strip. */
export function viewportFor(_screen: { w: number; h: number }, _hudHeight: number): Viewport {
  throw new Error('todo')
}
