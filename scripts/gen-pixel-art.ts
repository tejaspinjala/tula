/** Where the generated pixel art is committed. */
export const ART_DIR = new URL('../apps/web/src/assets/pixel', import.meta.url).pathname

/** Stub for the red run. */
export async function renderArt(): Promise<Map<string, Uint8Array>> {
  return new Map()
}
