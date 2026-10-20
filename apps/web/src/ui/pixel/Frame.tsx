import type { ReactNode } from 'react'

/** The frame styles. */
export type FrameVariant = 'wood' | 'paper' | 'dialog' | 'slot'

/** Props of Frame. */
export interface FrameProps {
  variant?: FrameVariant
  children?: ReactNode
  className?: string
}

/** Stub for the red run. */
export function Frame(_props: FrameProps) {
  return null
}
