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
  if (scene.campaigns.length > 0) {
    parts.push(
      scene.campaigns.length === 1
        ? 'A team Campaign is running.'
        : `${scene.campaigns.length} team Campaigns are running.`
    )
  }
  for (const room of scene.rooms) {
    if (room.board > 0 && scene.campaigns.length > 0) {
      const noun = room.board === 1 ? 'Quest' : 'Quests'
      parts.push(`${room.name}: ${room.board} ${noun} on the Quest Board.`)
    }
    const crew = scene.apprentices.filter((a) => a.hallId === room.hallId)
    if (crew.length > 0) {
      const noun = crew.length === 1 ? 'apprentice' : 'apprentices'
      parts.push(
        `${room.name}: ${crew.length} ${noun}, ${crew.map((a) => a.title ?? 'a Sub-Quest').join(', ')}.`
      )
    }
  }
  const newest = Object.values(scene.members)
    .flatMap((m) => (m.saying ? [{ name: m.name, saying: m.saying }] : []))
    .sort((a, b) => b.saying.seq - a.saying.seq)[0]
  if (newest) {
    parts.push(`${newest.name} says: ${newest.saying.text}.`)
  }
  parts.push(
    scene.scrolls.length === 0
      ? 'No Quests await a Seal.'
      : `${scene.scrolls.length} ${scene.scrolls.length === 1 ? 'Quest awaits' : 'Quests await'} a Seal: ${scene.scrolls.map((s) => s.title).join(', ')}.`
  )
  parts.push(`Treasury spend: ${formatCents(scene.coinsCents)}.`)
  return parts.join(' ')
}
