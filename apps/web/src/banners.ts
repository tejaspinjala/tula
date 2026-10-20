import type { ReplayEvent } from './replay'

/** The words of one ItemGet banner. */
export interface Banner {
  verb: string
  noun: string
  danger: boolean
}

/** The banner a live event earns, or null when it is not worth interrupting the walk. */
export function bannerFor(_event: ReplayEvent): Banner | null {
  return null
}
