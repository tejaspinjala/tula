import { useReducedMotion } from './useReducedMotion'

/** Props of ItemGet. */
export interface ItemGetProps {
  /** The lead words, e.g. "Earned 50". */
  verb: string
  /** The noun, picked out in an accent colour, e.g. "Renown". */
  noun: string
  danger?: boolean
}

/**
 * The item-get banner, used instead of toasts: it drops in at the top centre in four steps and
 * names what happened ("Earned 50 Renown!"). Good news is a polite `status`; danger gets a red
 * frame and an `alert`. Reduced motion shows it without sliding.
 */
export function ItemGet({ verb, noun, danger = false }: ItemGetProps) {
  const reduced = useReducedMotion()
  return (
    <div
      className="px-itemget"
      role={danger ? 'alert' : 'status'}
      data-danger={danger ? 'true' : undefined}
      data-motion={reduced ? 'none' : 'slide'}
    >
      <span className="px-itemget-icon" aria-hidden="true" />
      <span>
        {verb} <span className="px-itemget-noun">{noun}</span>!
      </span>
    </div>
  )
}
