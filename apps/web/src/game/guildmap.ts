import type { Point, Room } from './room'
import type { SceneState } from './scene'
import type { MapKey } from './world'

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

/** Derives the Guild Map from a scene state. */
export function guildMap(_input: GuildMapInput): GuildMap {
  return { current: 'hall', rooms: [], marks: [] }
}
