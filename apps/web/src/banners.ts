import type { ReplayEvent } from './replay'

/** The words of one ItemGet banner. */
export interface Banner {
  verb: string
  noun: string
  danger: boolean
}

/** The banner a live event earns, or null when it is not worth interrupting the walk. */
export function bannerFor(event: ReplayEvent): Banner | null {
  switch (event.type) {
    case 'seal.requested':
      return { verb: 'New', noun: 'Seal waiting', danger: false }
    case 'seal.approved':
      return { verb: 'Stamped', noun: 'a Seal', danger: false }
    case 'quest.done':
      return { verb: 'Finished', noun: 'a Quest', danger: false }
    case 'quest.dead':
      return { verb: 'Quest', noun: 'dead-lettered', danger: true }
    case 'gates.barred':
      return { verb: 'The Gates are', noun: 'barred', danger: true }
    case 'gates.lifted':
      return { verb: 'The Gates are', noun: 'lifted', danger: false }
    case 'steward.cap_reached':
      return { verb: 'Daily cap', noun: 'reached', danger: true }
    default:
      return null
  }
}
