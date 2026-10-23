import { type KeyboardEvent, type RefObject, useRef, useState } from 'react'
import { Badge } from './Badge'
import {
  type GuildMap,
  type MapDirection,
  type MapRoom,
  mapLayout,
  moveCursor,
} from './game/guildmap'
import type { MapKey } from './game/world'
import { NARROW_PX } from './MiniMap'
import { EmptyState, PixelButton } from './ui/pixel'

/** Props of {@link GuildMapPanel}. */
export interface GuildMapPanelProps {
  map: GuildMap | null
  /** Takes the Guild Master to a room (the existing teleport path). */
  onTravel: (id: MapKey) => void
}

const ARROWS: Record<string, MapDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

/** One room, as the schematic and the list view both draw it: its Hall name, badges and Member count. */
function RoomButton({
  room,
  current,
  cursor,
  onFocus,
  style,
  onTravel,
}: {
  room: MapRoom
  current: boolean
  cursor: boolean
  onFocus: () => void
  style?: { gridColumn: string; gridRow: number } | undefined
  onTravel: () => void
}) {
  return (
    <button
      type="button"
      className="gmap-room"
      data-room={room.id}
      data-here={current ? 'true' : undefined}
      data-kind={room.locked ? 'locked' : room.private ? 'private' : room.kind}
      aria-disabled={room.locked ? 'true' : undefined}
      aria-current={current ? 'location' : undefined}
      tabIndex={cursor ? 0 : -1}
      style={style}
      onFocus={onFocus}
      onClick={onTravel}
    >
      <span className="gmap-name">{room.name}</span>
      {current && <Badge tone="info">Here</Badge>}
      {room.locked && <Badge tone="danger">Locked</Badge>}
      {room.private && <Badge tone="private">Private</Badge>}
      {room.kind !== 'great' && room.kind !== 'town' && (
        <span className="gmap-count">
          {room.memberCount} {room.memberCount === 1 ? 'Member' : 'Members'}
        </span>
      )}
    </button>
  )
}

/** Focuses the room button with `id` inside `root`. */
function focusRoom(root: RefObject<HTMLElement | null>, id: MapKey): void {
  const found = [...(root.current?.querySelectorAll<HTMLElement>('[data-room]') ?? [])].find(
    (n) => n.dataset.room === id
  )
  found?.focus()
}

/**
 * The Guild Map page: a schematic of the Great Hall, every Hall room and the town maps (plaza, Archive, Counting House, trail) joined by doorway
 * lines, each room labelled with its Hall name, badges and Member count. Arrow keys move the ▶ cursor
 * between rooms and Enter travels there; a list view of the same rooms serves screen readers and
 * narrow screens.
 */
export function GuildMapPanel({ map, onTravel }: GuildMapPanelProps) {
  const root = useRef<HTMLDivElement | null>(null)
  const [list, setList] = useState(() => window.innerWidth < NARROW_PX)
  const [picked, setPicked] = useState<MapKey | null>(null)
  const [notice, setNotice] = useState('')
  if (!map || map.rooms.length === 0) {
    return (
      <EmptyState
        member="Steward"
        line="The Guild Map is not drawn yet. Walk into the Hall and it fills in."
      />
    )
  }
  const layout = mapLayout(map)
  const cursor = map.rooms.some((r) => r.id === picked)
    ? picked
    : map.rooms.some((r) => r.id === map.current)
      ? map.current
      : (map.rooms[0]?.id ?? null)
  const travel = (room: MapRoom) => {
    if (room.locked) {
      setNotice(`${room.name} is locked.`)
      return
    }
    setNotice('')
    onTravel(room.id)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (cursor === null) {
      return
    }
    const room = map.rooms.find((r) => r.id === cursor)
    if (event.key === 'Enter' && room) {
      event.preventDefault()
      travel(room)
      return
    }
    const dir = ARROWS[event.key]
    if (dir === undefined) {
      return
    }
    event.preventDefault()
    const next = list
      ? (map.rooms[
          map.rooms.findIndex((r) => r.id === cursor) + (dir === 'up' || dir === 'left' ? -1 : 1)
        ]?.id ?? cursor)
      : moveCursor(layout, cursor, dir)
    setPicked(next)
    focusRoom(root, next)
  }
  const rows = Math.max(...layout.slots.map((s) => s.row)) + 1
  const slotOf = (id: MapKey) => layout.slots.find((s) => s.id === id)
  const lines = map.rooms.flatMap((a) =>
    a.links
      .filter((b) => a.id < b)
      .flatMap((b) => {
        const from = slotOf(a.id)
        const to = slotOf(b)
        return from && to ? [{ key: `${a.id}>${b}`, from, to }] : []
      })
  )
  const node = (room: MapRoom, style?: { gridColumn: string; gridRow: number }) => (
    <RoomButton
      key={room.id}
      room={room}
      current={room.id === map.current}
      cursor={room.id === cursor}
      onFocus={() => setPicked(room.id)}
      style={style}
      onTravel={() => travel(room)}
    />
  )
  return (
    <div className="gmap" ref={root}>
      <div className="gmap-bar">
        <PixelButton onClick={() => setList((on) => !on)}>
          {list ? 'Schematic view' : 'List view'}
        </PixelButton>
        <p className="muted">Arrow keys move the cursor, Enter travels there.</p>
      </div>
      <p className="gmap-notice" role="status">
        {notice}
      </p>
      {list ? (
        <ul className="gmap-list" aria-label="Rooms of the Guildhall" onKeyDown={onKeyDown}>
          {map.rooms.map((room) => (
            <li key={room.id}>{node(room)}</li>
          ))}
        </ul>
      ) : (
        <div
          className="gmap-grid"
          role="application"
          aria-label="Guild Map schematic"
          onKeyDown={onKeyDown}
          style={{ gridTemplateColumns: `repeat(${layout.cols * 2}, 1fr)` }}
        >
          <svg
            className="gmap-lines"
            viewBox={`0 0 ${layout.cols * 2} ${rows}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {lines.map(({ key, from, to }) => (
              <line
                key={key}
                x1={from.col * 2 + 1}
                y1={from.row + 0.5}
                x2={to.col * 2 + 1}
                y2={to.row + 0.5}
              />
            ))}
          </svg>
          {map.rooms.map((room) => {
            const slot = slotOf(room.id)
            return slot
              ? node(room, { gridColumn: `${slot.col * 2 + 1} / span 2`, gridRow: slot.row + 1 })
              : null
          })}
        </div>
      )}
    </div>
  )
}
