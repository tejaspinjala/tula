import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Frame } from './Frame'

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
  /** Renders the trigger; spread the argument onto the focusable element. */
  children: (trigger: TooltipTriggerProps) => ReactNode
}

/** The props a Tooltip trigger must carry: they open it on hover and focus and link it for assistive tech. */
export interface TooltipTriggerProps {
  'aria-describedby': string | undefined
  onMouseOver: () => void
  onMouseOut: () => void
  onFocus: () => void
  onBlur: () => void
}

/**
 * A small Frame with a bold name, a muted category line, a divider and stat rows. It opens on
 * hover and on keyboard focus, closes on Esc, and is nudged back inside the viewport.
 */
export function Tooltip({ name, category, stats = [], children }: TooltipProps) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const tip = useRef<HTMLDivElement>(null)
  const open = (hovered || focused) && !dismissed

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDismissed(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Clamp to the viewport by shifting through the CSSOM (a custom property, so no inline style attribute).
  useLayoutEffect(() => {
    const node = tip.current
    if (!open || !node) {
      return
    }
    const box = node.getBoundingClientRect()
    const view = document.documentElement.clientWidth
    const shift = box.left < 0 ? -box.left : box.right > view && view > 0 ? view - box.right : 0
    node.style.setProperty('--shift', `${Math.round(shift)}px`)
  }, [open])

  return (
    <span className="px-tooltip-anchor">
      {children({
        'aria-describedby': open ? id : undefined,
        onMouseOver: () => {
          setDismissed(false)
          setHovered(true)
        },
        onMouseOut: () => setHovered(false),
        onFocus: () => {
          setDismissed(false)
          setFocused(true)
        },
        onBlur: () => setFocused(false),
      })}
      {open && (
        <div className="px-tooltip" role="tooltip" id={id} ref={tip}>
          <Frame variant="paper">
            <strong className="px-tooltip-name">{name}</strong>
            <span className="px-tooltip-category">{category}</span>
            {stats.length > 0 && <hr className="px-tooltip-divider" />}
            {stats.map((stat) => (
              <span className="px-tooltip-stat" key={stat.label}>
                <span>{stat.label}</span>
                <span>{stat.value}</span>
              </span>
            ))}
          </Frame>
        </div>
      )}
    </span>
  )
}
