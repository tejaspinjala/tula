/**
 * Renders the original three-quarter interior tileset (ADR-0016) from the palette-indexed pixel maps in
 * `apps/web/src/game/art` to packed PNG atlases plus JSON frame maps. Run `bun scripts/gen-hall-atlas.ts`
 * after changing the art or `tokens.css`; the output is committed under `apps/web/public/game`.
 */
import { packAtlases } from '../apps/web/src/game/art/atlas'
import { PALETTE, SHADOW_ALPHA } from '../apps/web/src/game/art/palette'
import { encodePng, palette, type Rgba } from './gen-pixel-art'

/** Where the atlases are committed. */
export const ATLAS_DIR = new URL('../apps/web/public/game', import.meta.url).pathname

const CLEAR: Rgba = [0, 0, 0, 0]

/** Draws every atlas file: file name to bytes. Deterministic for a given `tokens.css` and art. */
export async function renderHallAtlases(): Promise<Map<string, Uint8Array>> {
  const tokens = await palette()
  const colour = (ch: string): Rgba => {
    const token = PALETTE[ch]
    const rgba = token ? tokens[`--px-${token}`] : undefined
    if (!rgba) {
      return CLEAR
    }
    return ch === 'x' ? [rgba[0], rgba[1], rgba[2], SHADOW_ALPHA] : rgba
  }
  const out = new Map<string, Uint8Array>()
  for (const atlas of packAtlases()) {
    const pixels = atlas.rows.flatMap((row) => [...row].map(colour))
    out.set(`${atlas.name}.png`, encodePng(atlas.width, atlas.height, pixels))
    const map = {
      image: `${atlas.name}.png`,
      size: { w: atlas.width, h: atlas.height },
      frames: atlas.frames,
    }
    out.set(`${atlas.name}.json`, new TextEncoder().encode(`${JSON.stringify(map, null, 1)}\n`))
  }
  return out
}

if (import.meta.main) {
  for (const [name, bytes] of await renderHallAtlases()) {
    await Bun.write(`${ATLAS_DIR}/${name}`, bytes)
  }
}
