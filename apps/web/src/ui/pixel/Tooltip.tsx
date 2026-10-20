import type { ReactNode } from 'react'

/** One stat row of a Tooltip. */
export interface TooltipStat {
  label: string
  value: string
}

/** Props of Tooltip. */
export interface TooltipProps {
  name: string
  category: string
  stats?: readonly TooltipStat[]
  /** Renders the trigger; spread the argument onto it as `aria-describedby`. */
  children: (describedBy: string | undefined) => ReactNode
}

/** Stub for the red run. */
export function Tooltip(_props: TooltipProps) {
  return null
}
