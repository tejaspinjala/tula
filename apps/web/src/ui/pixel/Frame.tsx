import type { ReactNode } from 'react'

/** The frame styles. */
export type FrameVariant = 'wood' | 'paper' | 'dialog' | 'slot'

/** Props of Frame. */
export interface FrameProps {
  variant?: FrameVariant
  children?: ReactNode
  className?: string
}

/**
 * A pixel container. `wood` is the 9-slice wood-and-parchment frame, `paper` the parchment panel,
 * `dialog` the white dialogue box with stacked hard borders, `slot` a recessed inventory slot.
 * All the look is in `pixel.css`; pages compose Frames and never restyle them.
 */
export function Frame({ variant = 'wood', children, className }: FrameProps) {
  return (
    <div className={className ? `px-frame ${className}` : 'px-frame'} data-variant={variant}>
      {children}
    </div>
  )
}
