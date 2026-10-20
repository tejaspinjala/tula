import { useState } from 'react'
import { type Slot, SlotGrid } from '../ui/pixel'

/** One prebuilt piece on the palette. */
export interface Piece extends Slot {
  glyph: string
}

/** Props of {@link Palette}. */
export interface PaletteProps {
  label: string
  pieces: readonly Piece[]
  /** The drag data type the canvas accepts. */
  dragType: string
  /** The piece was chosen with a click or Enter (the keyboard way to add it). */
  onAdd: (id: string) => void
}

/**
 * The palette of prebuilt pieces: a SlotGrid of icons that can be dragged onto the canvas, or
 * chosen with Enter or a click. A caption under the grid names the piece under the cursor.
 */
export function Palette({ label, pieces, dragType, onAdd }: PaletteProps) {
  const [cursor, setCursor] = useState(pieces[0]?.id ?? '')
  const named = pieces.find((p) => p.id === cursor) ?? pieces[0]
  const follow = (target: EventTarget) => {
    if (!(target instanceof Element)) {
      return
    }
    const name = target.closest('[role="option"]')?.getAttribute('aria-label')
    const piece = pieces.find((p) => p.label === name)
    if (piece) {
      setCursor(piece.id)
    }
  }
  return (
    <fieldset
      className="palette"
      onFocus={(event) => follow(event.target)}
      onMouseOver={(event) => follow(event.target)}
    >
      <legend className="sr-only">{label}</legend>
      <SlotGrid
        label={label}
        slots={pieces}
        columns={Math.min(pieces.length, 8)}
        dragType={dragType}
        onSelect={(id) => {
          setCursor(id)
          onAdd(id)
        }}
      />
      <p className="palette-caption muted">
        {named ? `${named.label}. Drag it onto the board, or press Enter.` : ''}
      </p>
    </fieldset>
  )
}
