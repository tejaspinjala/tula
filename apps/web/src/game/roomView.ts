/**
 * The room renderer: loads the interiors and furniture atlases and places a room's sprites. Every
 * decision (which frame, where, in front of what) comes from `render.ts`; this only hands it to Phaser.
 */
import type Phaser from 'phaser'
import { z } from 'zod'
import { type Atlases, actorShadow, roomSprites, type Sprite } from './render'
import type { Room } from './room'

/** Texture keys of the two atlases. */
const INTERIORS = 'interiors'
export const FURNITURE = 'furniture'
const MAPS = { [INTERIORS]: 'interiors-map', [FURNITURE]: 'furniture-map' } as const

const atlasMap = z.object({
  frames: z.record(
    z.string(),
    z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  ),
})

/** Queues both atlases (image and frame map) on a scene's loader. */
export function preloadAtlases(scene: Phaser.Scene): void {
  for (const key of [INTERIORS, FURNITURE] as const) {
    scene.load.image(key, `/game/${key}.png`)
    scene.load.json(MAPS[key], `/game/${key}.json`)
  }
}

/** Cuts the loaded atlas images into named frames and returns every frame's size. */
export function registerAtlases(scene: Phaser.Scene): Atlases {
  const sizes: Atlases = { interiors: {}, furniture: {} }
  for (const key of [INTERIORS, FURNITURE] as const) {
    const parsed = atlasMap.safeParse(scene.cache.json.get(MAPS[key]))
    const texture = scene.textures.get(key)
    if (!parsed.success) {
      continue
    }
    for (const [name, f] of Object.entries(parsed.data.frames)) {
      if (!texture.has(name)) {
        texture.add(name, 0, f.x, f.y, f.w, f.h)
      }
      sizes[key][name] = { w: f.w, h: f.h }
    }
  }
  return sizes
}

/** Places one sprite at an offset, top-left anchored, at its depth. */
function place(scene: Phaser.Scene, sprite: Sprite, at: { x: number; y: number }) {
  return scene.add
    .image(at.x + sprite.x, at.y + sprite.y, sprite.atlas, sprite.frame)
    .setOrigin(0, 0)
    .setDepth(sprite.depth)
}

/** Draws every sprite of a room at a pixel offset; the caller destroys the result to redraw. */
export function drawRoom(
  scene: Phaser.Scene,
  room: Room,
  atlases: Atlases,
  at: { x: number; y: number }
): Phaser.GameObjects.Image[] {
  return roomSprites(room, atlases).map((sprite) => place(scene, sprite, at))
}

/** The hard pixel shadow under a character: an image the scene moves with its feet. */
export function makeShadow(scene: Phaser.Scene): Phaser.GameObjects.Image {
  const sprite = actorShadow({ x: 0, y: 0 })
  return scene.add.image(0, 0, sprite.atlas, sprite.frame).setOrigin(0, 0).setDepth(sprite.depth)
}

/** Moves a character's shadow under feet at `foot` px. */
export function moveShadow(shadow: Phaser.GameObjects.Image, foot: { x: number; y: number }): void {
  const sprite = actorShadow(foot)
  shadow.setPosition(sprite.x, sprite.y)
}
