import { type CSSProperties, useMemo } from 'react'
import { type RoomStyle, roomFor } from '../game/room'

/** What one tile of the preview is. */
export type PreviewCell = 'wall' | 'furniture' | 'floor'

/** The tiles of a style's smallest room as a flat grid, row-major, for the picker's preview. */
export function previewCells(style: RoomStyle): { width: number; cells: PreviewCell[] } {
  const room = roomFor(
    { id: 'preview', name: 'Preview', kind: 'work', locked: false },
    [{ id: 'preview-member' }],
    style
  )
  const furnished = new Set<number>()
  for (const f of room.furniture) {
    for (let y = f.tile.y; y < f.tile.y + f.tile.h; y++) {
      for (let x = f.tile.x; x < f.tile.x + f.tile.w; x++) {
        furnished.add(y * room.width + x)
      }
    }
  }
  const cells = room.collision.map((blocked, i): PreviewCell => {
    if (furnished.has(i)) {
      return 'furniture'
    }
    return blocked ? 'wall' : 'floor'
  })
  return { width: room.width, cells }
}

/** A small tile-by-tile picture of a room style: walls, furniture and floor, in the style's accent. */
export function RoomPreview({ style }: { style: RoomStyle }) {
  const { width, cells } = useMemo(() => previewCells(style), [style])
  const grid: CSSProperties = { gridTemplateColumns: `repeat(${width}, var(--px))` }
  return (
    <div
      role="img"
      aria-label={`${style} room preview`}
      data-testid="room-preview"
      data-style={style}
      className="room-preview"
      style={grid}
    >
      {cells.map((cell, i) => (
        <span key={`${i}-${cell}`} className={`room-preview-cell room-preview-${cell}`} />
      ))}
    </div>
  )
}
