import type { Phase } from './daylight'
import type { Light } from './room'

/** True when a light is lit in a phase: windows by day, sconces and lamps from dusk. */
export function lightIsOn(_phase: Phase, _light: Light): boolean {
  throw new Error('todo')
}
