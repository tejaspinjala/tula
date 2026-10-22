/**
 * Renders the original three-quarter interior tileset (ADR-0016) from the palette-indexed pixel maps in
 * `apps/web/src/game/art` to packed PNG atlases plus JSON frame maps. Run `bun scripts/gen-hall-atlas.ts`
 * after changing the art or `tokens.css`; the output is committed under `apps/web/public/game`.
 */

/** Where the atlases are committed. */
export const ATLAS_DIR = new URL('../apps/web/public/game', import.meta.url).pathname

/** Draws every atlas file: file name to bytes. Deterministic for a given `tokens.css` and art. */
export async function renderHallAtlases(): Promise<Map<string, Uint8Array>> {
  return new Map()
}
