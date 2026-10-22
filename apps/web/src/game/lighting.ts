import type { Phase } from './daylight'
import type { Light } from './room'

/** True when a light is lit in a phase: windows by day, sconces and lamps from dusk. */
export function lightIsOn(phase: Phase, light: Light): boolean {
  return light.kind === 'window' ? phase !== 'night' : phase !== 'day'
}

/** A hard-edged rectangle of daylight on the floor, in tiles. */
export interface LightPatch {
  x: number
  y: number
  w: number
  h: number
  alpha: number
}

/** The patches the windows throw in a phase; none at night. */
export function lightPatches(lights: readonly Light[], phase: Phase): LightPatch[] {
  if (phase === 'night') {
    return []
  }
  const dusk = phase === 'dusk'
  return lights
    .filter((l) => l.kind === 'window')
    .map((l) => ({
      x: l.tile.x + (dusk ? 1 : 0),
      y: l.tile.y + 1,
      w: 2,
      h: dusk ? 3 : 2,
      alpha: dusk ? 0.12 : 0.18,
    }))
}

/** One stepped band of a lamp pool: a circle on a tile centre, radius in tiles. */
export interface LampPool {
  x: number
  y: number
  radius: number
  alpha: number
}

/** The stepped pools lamps and sconces cast in a phase; none by day. */
export function lampPools(lights: readonly Light[], phase: Phase): LampPool[] {
  if (phase === 'day') {
    return []
  }
  const bands = phase === 'night' ? 3 : 2
  return lights
    .filter((l) => l.kind !== 'window')
    .flatMap((l) =>
      Array.from({ length: bands }, (_v, i) => ({
        x: l.tile.x + 0.5,
        y: l.tile.y + 0.5,
        radius: l.radius - i,
        alpha: 0.08,
      }))
    )
}

/** How long the light takes to change between phases, in ms: nothing under reduced motion. */
export function lightFadeMs(reduced: boolean): number {
  return reduced ? 0 : 600
}
