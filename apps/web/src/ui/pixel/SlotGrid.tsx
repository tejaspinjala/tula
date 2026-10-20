import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'

/** One slot of a SlotGrid. */
export interface Slot {
  id: string
  label: string
  count?: number
  /** A short UPPERCASE mark drawn in the slot in place of the stock icon. */
  glyph?: string
}

/** Props of SlotGrid. */
export interface SlotGridProps {
  label: string
  slots: readonly Slot[]
  columns: number
  onSelect: (id: string) => void
  /** When set, slots can be dragged; the drag carries the slot id under this data type. */
  dragType?: string
}

/**
 * An inventory grid of square recessed slots. Arrow keys move across and down (clamped at the
 * edges), Enter or a click selects. The count sits bottom-right; the cursor slot gets a thick
 * gold outline, never a glow.
 */
export function SlotGrid({ label, slots, columns, onSelect, dragType }: SlotGridProps) {
  const [cursor, setCursor] = useState(0)
  const grid = useRef<HTMLDivElement>(null)
  const cells = useRef<(HTMLDivElement | null)[]>([])

  useLayoutEffect(() => {
    grid.current?.style.setProperty('--cols', String(columns))
  }, [columns])

  function move(to: number) {
    const next = Math.min(Math.max(to, 0), slots.length - 1)
    setCursor(next)
    cells.current[next]?.focus()
  }

  function onKeyDown(event: KeyboardEvent, index: number) {
    switch (event.key) {
      case 'ArrowRight':
        move(cursor + 1)
        break
      case 'ArrowLeft':
        move(cursor - 1)
        break
      case 'ArrowDown':
        move(cursor + columns)
        break
      case 'ArrowUp':
        move(cursor - columns)
        break
      case 'Enter':
      case ' ': {
        const slot = slots[index]
        if (slot) {
          onSelect(slot.id)
        }
        break
      }
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div className="px-slotgrid" role="listbox" aria-label={label} ref={grid}>
      {slots.map((slot, index) => (
        <div
          key={slot.id}
          ref={(node) => {
            cells.current[index] = node
          }}
          className="px-slot"
          role="option"
          aria-label={slot.count === undefined ? slot.label : `${slot.label}, ${slot.count}`}
          aria-selected={index === cursor}
          tabIndex={index === cursor ? 0 : -1}
          draggable={dragType === undefined ? undefined : true}
          onDragStart={(event) => {
            if (dragType !== undefined) {
              event.dataTransfer.setData(dragType, slot.id)
              event.dataTransfer.effectAllowed = 'copy'
            }
          }}
          onKeyDown={(event) => onKeyDown(event, index)}
          onFocus={() => setCursor(index)}
          onClick={() => {
            setCursor(index)
            onSelect(slot.id)
          }}
        >
          {slot.glyph === undefined ? (
            <span className="px-slot-art" aria-hidden="true" />
          ) : (
            <span className="px-slot-glyph" data-glyph={slot.glyph} aria-hidden="true" />
          )}
          {slot.count !== undefined && (
            <span className="px-slot-count" aria-hidden="true">
              {slot.count}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
