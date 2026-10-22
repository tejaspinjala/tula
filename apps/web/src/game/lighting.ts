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
export function lightPatches(_lights: readonly Light[], _phase: Phase): LightPatch[] {
  return []
}

/** One stepped band of a lamp pool: a circle on a tile centre, radius in tiles. */
export interface LampPool {
  x: number
  y: number
  radius: number
  alpha: number
}

/** The stepped pools lamps and sconces cast in a phase; none by day. */
export function lampPools(_lights: readonly Light[], _phase: Phase): LampPool[] {
  return []
}

/** How long the light takes to change between phases, in ms: nothing under reduced motion. */
export function lightFadeMs(_reduced: boolean): number {
  return -1
}
