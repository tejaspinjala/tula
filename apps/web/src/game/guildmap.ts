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
