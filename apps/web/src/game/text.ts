import { z } from 'zod'
import type { ReplayEvent } from '../replay'
import { formatCents } from '../treasury'
import type { SceneState } from './scene'

const frame = z.object({
  type: z.literal('event'),
  event: z.object({
    seq: z.number(),
    type: z.string(),
    payload: z.unknown(),
    occurredAt: z.string(),
  }),
})

/** Reads one stream frame into its event; snapshots and malformed frames give null. */
export function readEventFrame(raw: string): ReplayEvent | null {
  let data: unknown = null
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = frame.safeParse(data)
  return parsed.success ? parsed.data.event : null
}

/** One plain-language summary of what the canvas shows, for the live region. */
export function sceneSummary(scene: SceneState): string {
  const parts = ['Guild hall.']
  if (scene.gateClosed) {
    parts.push('The gates are barred.')
  }
  for (const room of scene.rooms) {
    if (room.locked) {
      parts.push(`${room.name} is locked.`)
      continue
    }
    const members = room.memberIds.flatMap((id) => {
      const member = scene.members[id]
      return member ? [member] : []
    })
    const working = members.filter((m) => m.status === 'working')
    const titles = (m: (typeof members)[number]) => {
      const quest = m.bubble?.text
      return quest ? ` on ${quest}` : ''
    }
    if (members.length === 0) {
      parts.push(`${room.name} has no Members.`)
    } else if (working.length === 0) {
      parts.push(`${room.name}: all ${members.length} Members idle.`)
    } else {
      parts.push(
        `${room.name}: ${working.map((m) => `${m.name} is working${titles(m)}`).join(', ')}.`
      )
    }
    if (room.paused) {
      parts.push(`${room.name} is paused.`)
    }
  }
  parts.push(
    scene.scrolls.length === 0
      ? 'No Quests await a Seal.'
      : `${scene.scrolls.length} ${scene.scrolls.length === 1 ? 'Quest awaits' : 'Quests await'} a Seal: ${scene.scrolls.map((s) => s.title).join(', ')}.`
  )
  parts.push(`Treasury spend: ${formatCents(scene.coinsCents)}.`)
  return parts.join(' ')
}

/** The teleport menu entry of a room: locked ones are marked as such. */
export function teleportLabel(room: { name: string; locked: boolean }): string {
  return room.locked ? `${room.name} (locked)` : room.name
}
