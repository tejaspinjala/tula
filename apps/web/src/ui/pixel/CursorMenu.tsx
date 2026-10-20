import { type KeyboardEvent, useRef, useState } from 'react'

/** One row of a CursorMenu. */
export interface CursorMenuItem {
  id: string
  label: string
  disabled?: boolean
}

/** Props of CursorMenu. */
export interface CursorMenuProps {
  label: string
  items: readonly CursorMenuItem[]
  onSelect: (id: string) => void
  onBack?: (() => void) | undefined
}

/**
 * A ▶ cursor menu: a listbox with a roving tabindex. Up/Down wrap, Home/End jump, Enter selects,
 * Esc or Backspace goes back. Hovering a row moves the cursor; the selected row shows the ▶.
 */
export function CursorMenu({ label, items, onSelect, onBack }: CursorMenuProps) {
  const [cursor, setCursor] = useState(0)
  const rows = useRef<(HTMLLIElement | null)[]>([])

  function move(to: number, focus = true) {
    const next = (to + items.length) % items.length
    setCursor(next)
    if (focus) {
      rows.current[next]?.focus()
    }
  }

  function choose(index: number) {
    const item = items[index]
    if (item && !item.disabled) {
      onSelect(item.id)
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown':
        move(cursor + 1)
        break
      case 'ArrowUp':
        move(cursor - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(items.length - 1)
        break
      case 'Enter':
        choose(cursor)
        break
      case 'Escape':
      case 'Backspace':
        onBack?.()
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <ul className="px-menu" role="listbox" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) => (
        <li
          key={item.id}
          ref={(node) => {
            rows.current[index] = node
          }}
          className="px-menu-item"
          role="option"
          aria-selected={index === cursor}
          aria-disabled={item.disabled === true ? true : undefined}
          tabIndex={index === cursor ? 0 : -1}
          onMouseOver={() => setCursor(index)}
          onClick={() => {
            setCursor(index)
            choose(index)
          }}
        >
          {item.label}
        </li>
      ))}
    </ul>
  )
}
