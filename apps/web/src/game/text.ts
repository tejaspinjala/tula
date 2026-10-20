import type { ReplayEvent } from '../replay'
import type { SceneState } from './scene'

/** Reads one stream frame into its event; snapshots and malformed frames give null. */
export function readEventFrame(_raw: string): ReplayEvent | null {
  return null
}

/** One plain-language summary of what the canvas shows, for the live region. */
export function sceneSummary(_scene: SceneState): string {
  return ''
}
