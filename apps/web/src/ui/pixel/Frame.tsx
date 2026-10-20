import { type ReactNode, useLayoutEffect, useRef } from 'react'
import { steppedCorners } from './steppedCorners'

/** The frame styles. */
export type FrameVariant = 'wood' | 'paper' | 'dialog' | 'slot'

/** Props of Frame. */
export interface FrameProps {
  variant?: FrameVariant
  children?: ReactNode
  className?: string
}

/**
 * A pixel container. `wood` is the 9-slice wood frame, `paper` the parchment panel, `dialog` the
 * white dialogue box with hard borders, `slot` a recessed inventory slot. Everything but wood gets
 * stepped corners from `steppedCorners` (set through the CSSOM, so the CSP needs no inline
 * styles). All the look is in `pixel.css`; pages compose Frames and never restyle them.
 */
export function Frame({ variant = 'wood', children, className }: FrameProps) {
  const root = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = root.current
    if (!node || variant === 'wood') {
      return
    }
    node.style.setProperty('--clip-out', steppedCorners('var(--px)', variant === 'slot' ? 1 : 2))
    node.style.setProperty('--clip-in', steppedCorners('var(--px)', 1))
  }, [variant])

  return (
    <div
      className={className ? `px-frame ${className}` : 'px-frame'}
      data-variant={variant}
      ref={root}
    >
      <div className="px-frame-ring">
        <div className="px-frame-in">{children}</div>
      </div>
    </div>
  )
}
