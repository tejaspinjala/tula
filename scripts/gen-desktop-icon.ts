/**
 * Draws the Guildhall desktop app icon from the token palette: a wood-framed guild hall with a
 * gold star, 32x32 pixels scaled 32x to the 1024 square Tauri expects. Run
 * `bun scripts/gen-desktop-icon.ts`; the output is committed at `apps/desktop/src-tauri/app-icon.png`
 * and `tauri icon` derives the platform sizes from it at build time.
 */
import { encodePng, palette, type Rgba } from './gen-pixel-art'

/** Where the icon source is committed. */
export const ICON_PATH = new URL('../apps/desktop/src-tauri/app-icon.png', import.meta.url).pathname

const SIZE = 32
const SCALE = 32
const CLEAR: Rgba = [0, 0, 0, 0]

const STAR = [
  '.....##.....',
  '.....##.....',
  '############',
  '.##########.',
  '..########..',
  '...######...',
  '..########..',
  '.####..####.',
  '###......###',
] as const

/** Draws the icon: deterministic for a given `tokens.css`. */
export async function renderDesktopIcon(): Promise<Uint8Array> {
  const p = await palette()
  const color = (name: string): Rgba => p[`--px-${name}`] ?? CLEAR
  const px = new Array<Rgba>(SIZE * SIZE).fill(CLEAR)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y)
      // Round the corners by dropping the corner pixels.
      if (Math.min(x, SIZE - 1 - x) + Math.min(y, SIZE - 1 - y) < 3) {
        continue
      }
      const lit = Math.min(x, y) <= Math.min(SIZE - 1 - x, SIZE - 1 - y)
      let name = 'wood-500'
      if (d === 0) {
        name = 'ink'
      } else if (d === 1) {
        name = lit ? 'wood-300' : 'wood-700'
      } else if (d >= 3 && d <= 4) {
        name = 'wood-900'
      } else if (d > 4) {
        name = 'sky-700'
      }
      px[y * SIZE + x] = color(name)
    }
  }
  STAR.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] === '#') {
        px[(11 + j) * SIZE + 10 + i] = color(j > 5 ? 'gold-700' : 'gold-500')
      }
    }
  })
  const side = SIZE * SCALE
  const big = new Array<Rgba>(side * side)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      big[y * side + x] = px[Math.floor(y / SCALE) * SIZE + Math.floor(x / SCALE)] ?? CLEAR
    }
  }
  return encodePng(side, side, big)
}

if (import.meta.main) {
  await Bun.write(ICON_PATH, await renderDesktopIcon())
}
