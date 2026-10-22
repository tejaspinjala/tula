import { memberSpot } from './actors'
import type { Point, Room } from './room'
import type { SceneState } from './scene'
import { isRoomMapId, type MapKey } from './world'

/** One room of the Guild Map. */
export interface MapRoom {
  id: MapKey
  hallId: string | null
  name: string
  kind: 'great' | 'work' | 'private'
  locked: boolean
  private: boolean
  memberCount: number
  bounds: { x: number; y: number; w: number; h: number }
  links: MapKey[]
}

/** The state a Member mark shows. */
export type MemberState = 'working' | 'waiting_seal' | 'idle' | 'away'

/** A mark on the map. */
export type MapMark =
  | { kind: 'guildMaster'; room: MapKey; tile: Point }
  | { kind: 'member'; id: string; name: string; room: MapKey; tile: Point; state: MemberState }
  | {
      kind: 'poi'
      poi: 'seal-desk' | 'mailbox' | 'quest-board' | 'gate'
      room: MapKey
      tile: Point
      count: number
      closed: boolean
    }

/** The Guild Map model. */
export interface GuildMap {
  current: MapKey
  rooms: MapRoom[]
  marks: MapMark[]
}

/** Inputs of {@link guildMap}. */
export interface GuildMapInput {
  scene: SceneState
  /** The room of a map key (null for a town map or an unknown Hall). */
  roomOf: (key: MapKey) => Room | null
  current: MapKey
  master: Point | null
  unread: number
}

const POIS = ['seal-desk', 'mailbox', 'quest-board', 'gate'] as const

/** The map key a doorway target names, when it is a room of the Guildhall (not a town map). */
function roomTarget(target: string): MapKey | null {
  if (target === 'great-hall') {
    return 'hall'
  }
  return isRoomMapId(target) ? target : null
}

/** Derives the Guild Map from a scene state: rooms with flags and links, and the marks in them. */
export function guildMap(input: GuildMapInput): GuildMap {
  const { scene, roomOf, current, master, unread } = input
  const rooms: MapRoom[] = []
  const marks: MapMark[] = []
  const away = new Set<string>()
  for (const r of scene.rooms) {
    if (r.locked || r.paused) {
      for (const id of r.memberIds) {
        away.add(id)
      }
    }
  }
  const add = (
    id: MapKey,
    room: Room,
    meta: Pick<MapRoom, 'hallId' | 'name' | 'kind' | 'locked' | 'memberCount'>
  ) => {
    rooms.push({
      id,
      ...meta,
      private: meta.kind === 'private' && !meta.locked,
      bounds: { x: 0, y: 0, w: room.width, h: room.height },
      links: room.doorways.flatMap((d) => {
        const key = roomTarget(d.target)
        return key === null ? [] : [key]
      }),
    })
    for (const poi of room.pois) {
      const kind = POIS.find((k) => k === poi.kind)
      if (kind === undefined) {
        continue
      }
      const board =
        meta.hallId === null
          ? scene.rooms.reduce((sum, r) => sum + r.board, 0)
          : (scene.rooms.find((r) => r.hallId === meta.hallId)?.board ?? 0)
      const count =
        kind === 'seal-desk'
          ? scene.scrolls.length
          : kind === 'mailbox'
            ? unread
            : kind === 'quest-board'
              ? board
              : 0
      marks.push({
        kind: 'poi',
        poi: kind,
        room: id,
        tile: poi.stand,
        count,
        closed: kind === 'gate' && scene.gateClosed,
      })
    }
  }
  const great = roomOf('hall')
  if (great) {
    add('hall', great, {
      hallId: null,
      name: 'Great Hall',
      kind: 'great',
      locked: false,
      memberCount: 0,
    })
  }
  for (const r of scene.rooms) {
    const key: MapKey = `hall:${r.hallId}`
    const room = roomOf(key)
    if (!room) {
      continue
    }
    add(key, room, {
      hallId: r.hallId,
      name: r.name,
      kind: r.kind,
      locked: r.locked,
      memberCount: r.memberIds.length,
    })
    for (const id of r.memberIds) {
      const m = scene.members[id]
      if (!m) {
        continue
      }
      const state: MemberState = away.has(id)
        ? 'away'
        : m.awaitingSeal
          ? 'waiting_seal'
          : m.status === 'working'
            ? 'working'
            : 'idle'
      marks.push({
        kind: 'member',
        id,
        name: m.name,
        room: key,
        tile: memberSpot(room, key, id),
        state,
      })
    }
  }
  if (master) {
    marks.push({ kind: 'guildMaster', room: current, tile: master })
  }
  return { current, rooms, marks }
}

/** Where and how large the mini map draws a room. */
export interface MiniView {
  /** Canvas pixels per map tile, always a whole number. */
  scale: number
  /** The first tile column and row shown. */
  originX: number
  originY: number
}

/**
 * The window of a room the mini map canvas shows: the largest whole-number scale at which the room
 * fits, else scale 1 cropped to the canvas and centred on `focus`, kept inside the room.
 */
export function miniView(
  room: { w: number; h: number },
  focus: Point,
  canvas: { w: number; h: number }
): MiniView {
  const scale = Math.max(1, Math.floor(Math.min(canvas.w / room.w, canvas.h / room.h)))
  const cols = Math.min(room.w, Math.floor(canvas.w / scale))
  const rows = Math.min(room.h, Math.floor(canvas.h / scale))
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max))
  return {
    scale,
    originX: clamp(focus.x - Math.floor(cols / 2), room.w - cols),
    originY: clamp(focus.y - Math.floor(rows / 2), room.h - rows),
  }
}

/** What the screen-reader location summary says of the mini map. */
export function mapSummary(map: GuildMap): string {
  const here = map.rooms.find((r) => r.id === map.current)
  if (!here) {
    return 'Mini map: not in a room of the Guildhall.'
  }
  const label = (r: MapRoom) => `${r.name}${r.locked ? ' (locked)' : r.private ? ' (private)' : ''}`
  const near = map.rooms.filter((r) => here.links.includes(r.id))
  const parts = [`Mini map: ${label(here)}.`]
  parts.push(near.length > 0 ? `Doors lead to ${near.map(label).join(', ')}.` : 'No doors.')
  const inRoom = map.marks.filter((m) => m.room === map.current)
  const waiting = inRoom.filter((m) => m.kind === 'member' && m.state === 'waiting_seal').length
  if (waiting > 0) {
    parts.push(`${waiting} waiting for a Seal.`)
  }
  for (const m of inRoom) {
    if (m.kind !== 'poi' || m.count === 0) {
      continue
    }
    if (m.poi === 'seal-desk') {
      parts.push(`${m.count} waiting at the Seal desk.`)
    } else if (m.poi === 'mailbox') {
      parts.push(`${m.count} unread in the mailbox.`)
    } else if (m.poi === 'quest-board') {
      parts.push(`${m.count} on the Quest Board.`)
    }
  }
  if (inRoom.some((m) => m.kind === 'poi' && m.poi === 'gate' && m.closed)) {
    parts.push('The gate is barred.')
  }
  return parts.join(' ')
}

/** Where the schematic puts a room, in grid cells (a column may be fractional). */
export interface MapSlot {
  id: MapKey
  col: number
  row: number
}

/** The schematic grid: every room's slot, the Town's column, and the grid width in columns. */
export interface MapLayout {
  slots: MapSlot[]
  /** The Town hangs off the Great Hall's row, in the column right of every Hall room. */
  townCol: number
  cols: number
}

/** Lays the rooms out: the Great Hall on top, the Hall rooms in rows of up to four below it. */
export function mapLayout(_map: GuildMap): MapLayout {
  return { slots: [], townCol: 0, cols: 0 }
}

/** A direction the ▶ cursor moves on the schematic. */
export type MapDirection = 'up' | 'down' | 'left' | 'right'

/** The room the cursor lands on moving `dir` from `from`; `from` itself when nothing lies that way. */
export function moveCursor(_layout: MapLayout, from: MapKey, _dir: MapDirection): MapKey {
  return from
}
