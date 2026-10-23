/**
 * The pure decisions of moving between rooms: the stepped fade through a doorway, the last room
 * kept in browser storage, the name the live region speaks and the lines of a doorway sign. No
 * Phaser; the scene only runs what this returns.
 */
import { hallTitle } from './walk'
import { isRoomMapId, type MapKey, readSavedMapId } from './world'

/** Steps to black (and the same number back) when walking through a doorway. */
const FADE_FRAMES = 4
/** How long each stepped frame of the fade lasts, in ms. */
export const FADE_FRAME_MS = 70

const steps = Array.from({ length: FADE_FRAMES }, (_v, i) => (i + 1) / FADE_FRAMES)

/** The black opacities of the frames going out: four steps to black, or none under reduced motion. */
export function fadeOutAlphas(reducedMotion: boolean): number[] {
  return reducedMotion ? [] : steps
}

/** The black opacities of the frames coming back: four steps to clear, or none under reduced motion. */
export function fadeInAlphas(reducedMotion: boolean): number[] {
  return reducedMotion ? [] : [...steps].reverse().map((a) => a - 1 / FADE_FRAMES)
}

/** The browser storage key of a guild's last room. */
export function locationKey(guildId: string): string {
  return `guildhall.location.${guildId}`
}

/** The part of browser storage the saved location uses. */
export interface LocationStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** The browser's local storage, or null when it is blocked or missing (a private window, a test). */
export function browserStore(): LocationStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The map key a stored value names: a town map (the renamed `vault` too) or a `hall:<id>` room; else null. */
export function parseLocation(raw: string | null): MapKey | null {
  if (raw === null) {
    return null
  }
  if (isRoomMapId(raw)) {
    return raw.length > 'hall:'.length ? raw : null
  }
  return readSavedMapId(raw)
}

/**
 * Where the Guild Master opens: the guild's saved room while it still exists, else the Great Hall
 * (also when storage is blocked, empty or holds junk).
 */
export function restoreLocation(
  store: LocationStore | null | undefined,
  guildId: string,
  exists: (key: MapKey) => boolean
): MapKey {
  try {
    const saved = parseLocation(store?.getItem(locationKey(guildId)) ?? null)
    return saved !== null && exists(saved) ? saved : 'hall'
  } catch {
    return 'hall'
  }
}

/** Remembers the guild's current room; a blocked or full store is ignored. */
export function rememberLocation(
  store: LocationStore | null | undefined,
  guildId: string,
  key: MapKey
): void {
  try {
    store?.setItem(locationKey(guildId), key)
  } catch {
    // The room is only a convenience: losing it falls back to the Great Hall.
  }
}

const TOWN_NAMES: Record<string, string> = {
  hall: 'Great Hall',
  plaza: 'Plaza',
  archive: 'Archive',
  'counting-house': 'Counting House',
  trail: 'Trail',
}

/** What the live region names a map: a town map by its name, a Hall as "<name> Hall". */
export function locationName(
  key: MapKey,
  hallName: (hallId: string) => string | undefined
): string {
  if (isRoomMapId(key)) {
    const name = hallName(key.slice('hall:'.length))
    return name ? hallTitle(name) : 'empty room'
  }
  return TOWN_NAMES[key] ?? 'Great Hall'
}

/** What the live region says on entering a room named `name`. */
export function announceLocation(name: string): string {
  return name === 'empty room' ? 'You are in an empty room.' : `You are in the ${name}.`
}

/**
 * The lines of a doorway sign: words wrap at `width` characters, a word longer than a line is split
 * with a hyphen, and a name past `lines` lines ends in a tilde. The whole name is shown.
 */
export function signLines(name: string, width = 13, lines = 3): string[] {
  const out: string[] = []
  let line = ''
  const flush = () => {
    if (line !== '') {
      out.push(line)
      line = ''
    }
  }
  for (const word of name.trim().split(/\s+/)) {
    let rest = word
    while (rest.length > width) {
      flush()
      out.push(`${rest.slice(0, width - 1)}-`)
      rest = rest.slice(width - 1)
    }
    if (line === '') {
      line = rest
    } else if (line.length + 1 + rest.length <= width) {
      line = `${line} ${rest}`
    } else {
      flush()
      line = rest
    }
  }
  flush()
  if (out.length <= lines) {
    return out
  }
  const kept = out.slice(0, lines)
  const last = kept[lines - 1] ?? ''
  kept[lines - 1] = `${last.replace(/-$/, '').slice(0, width - 1)}~`
  return kept
}

/** The scale of sign lettering at a camera zoom: the inverse of the zoom (one screen pixel per font pixel), half size below zoom 2. */
export function signScale(zoom: number): number {
  return zoom >= 2 ? 1 / zoom : 0.5
}

/** The left edge of a line `width` px wide centred on `centre`, snapped to a whole screen pixel at `zoom` so thin letters never vanish. */
export function snapSignLeft(centre: number, width: number, zoom: number): number {
  return Math.round((centre - width / 2) * zoom) / zoom
}
