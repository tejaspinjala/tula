import { useEffect, useRef, useState } from 'react'
import { type GuildMap, mapSummary, miniView } from './game/guildmap'
import { Frame, PixelButton } from './ui/pixel'

/** Props of {@link MiniMap}. */
export interface MiniMapProps {
  map: GuildMap
  /** Opens the Guild Map page; absent until that page exists (the map button then does nothing). */
  onOpen?: (() => void) | undefined
  /** The Mailbox's unread count, shown as a badge on the collapsed map button; nothing at 0. */
  unread?: number | undefined
}

/** Under this viewport width (px) the mini map collapses to a map button. */
export const NARROW_PX = 600

/** The canvas the mini map draws into, in its own pixels (the CSS size is a whole multiple). */
const CANVAS = { w: 96, h: 72 } as const

/** True while the viewport is narrower than {@link NARROW_PX}; follows window resizes. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_PX)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_PX)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}

/** True when a key press is aimed at something the user types into. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/** Draws the current room of the map into a canvas at a whole-number scale, centred on the Guild Master. */
function draw(canvas: HTMLCanvasElement, map: GuildMap): void {
  const ctx = canvas.getContext('2d')
  const room = map.rooms.find((r) => r.id === map.current)
  if (!ctx || !room) {
    return
  }
  const css = getComputedStyle(canvas)
  const colour = (name: string) => css.getPropertyValue(name).trim() || 'currentColor'
  const master = map.marks.find((m) => m.kind === 'guildMaster')
  const focus = master?.tile ?? { x: room.bounds.w >> 1, y: room.bounds.h >> 1 }
  const view = miniView({ w: room.bounds.w, h: room.bounds.h }, focus, CANVAS)
  const cell = (x: number, y: number, fill: string, size = 1) => {
    ctx.fillStyle = fill
    ctx.fillRect(
      (x - view.originX) * view.scale,
      (y - view.originY) * view.scale,
      view.scale * size,
      view.scale * size
    )
  }
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = colour('--px-wood-900')
  ctx.fillRect(0, 0, CANVAS.w, CANVAS.h)
  ctx.fillStyle = room.locked ? colour('--px-stone-500') : colour('--px-paper-400')
  ctx.fillRect(0, 0, room.bounds.w * view.scale, room.bounds.h * view.scale)
  // Neighbours show as doorway stubs on this room's edge, tinted by their own flags.
  const byId = new Map(map.rooms.map((r) => [r.id, r]))
  for (const link of room.links) {
    const next = byId.get(link)
    if (next) {
      const at = Math.max(0, Math.min(room.bounds.w - 1, Math.floor(room.bounds.w / 2)))
      cell(
        at + room.links.indexOf(link) - (room.links.length >> 1),
        room.bounds.h - 1,
        next.locked
          ? colour('--px-danger-400')
          : next.private
            ? colour('--px-plum-500')
            : colour('--px-gold-500')
      )
    }
  }
  for (const mark of map.marks) {
    if (mark.room !== map.current) {
      continue
    }
    if (mark.kind === 'poi') {
      const waiting = mark.count > 0 || mark.closed
      cell(mark.tile.x, mark.tile.y, waiting ? colour('--px-warn-500') : colour('--px-sky-500'))
    } else if (mark.kind === 'member') {
      const fill =
        mark.state === 'working'
          ? colour('--px-grass-500')
          : mark.state === 'waiting_seal'
            ? colour('--px-warn-500')
            : mark.state === 'away'
              ? colour('--px-stone-300')
              : colour('--px-sage-300')
      cell(mark.tile.x, mark.tile.y, fill)
    }
  }
  if (master) {
    cell(master.tile.x, master.tile.y, colour('--px-ink'))
    cell(master.tile.x, master.tile.y, colour('--px-gold-500'), 1)
    ctx.strokeStyle = colour('--px-ink')
    ctx.strokeRect(
      (master.tile.x - view.originX) * view.scale + 0.5,
      (master.tile.y - view.originY) * view.scale + 0.5,
      view.scale - 1,
      view.scale - 1
    )
  }
}

/** The canvas: redrawn when the map (the scene state) changes, never per frame. */
function MiniCanvas({ map }: { map: GuildMap }) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (canvas.current) {
      draw(canvas.current, map)
    }
  }, [map])
  return <canvas ref={canvas} className="minimap-canvas" width={CANVAS.w} height={CANVAS.h} />
}

/**
 * The mini map: the current room and its doors drawn small in a corner frame, centred on the Guild
 * Master. It redraws when the map (the scene state) changes, never per frame. M hides and shows it;
 * under 600 px wide it is a framed map button that opens the Guild Map page. A screen reader gets
 * the same content as text.
 */
export function MiniMap({ map, onOpen, unread = 0 }: MiniMapProps) {
  const narrow = useNarrow()
  const [shown, setShown] = useState(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === 'm' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isTyping(e.target)
      ) {
        setShown((on) => !on)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (narrow) {
    return (
      <div className="minimap minimap-collapsed">
        <Frame>
          <PixelButton
            aria-label={unread > 0 ? `Open the Guild Map, ${unread} unread` : 'Open the Guild Map'}
            onClick={() => onOpen?.()}
          >
            Map
            {unread > 0 && <span className="minimap-badge"> {unread}</span>}
          </PixelButton>
        </Frame>
      </div>
    )
  }
  if (!shown) {
    return null
  }
  return (
    <div className="minimap">
      <Frame>
        <div role="img" aria-label={mapSummary(map)}>
          <MiniCanvas map={map} />
        </div>
      </Frame>
    </div>
  )
}
