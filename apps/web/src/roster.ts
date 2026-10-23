import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { lookChoice } from './game/look'
import { ROOM_STYLES } from './game/room'
import { PasskeyRequestError, type Session } from './passkeys'

const agent = z.object({ id: z.string(), name: z.string() })
const hall = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['work', 'private']),
  locked: z.boolean(),
  captain: agent.nullable(),
  roomStyle: z.enum(ROOM_STYLES).optional(),
  members: z.array(agent.extend({ rank: z.string(), look: lookChoice.optional() })),
})
const page = z.object({ steward: agent, halls: z.array(hall), next: z.string().nullable() })

/** One Hall of the roster, with its Captain and Members. */
export type RosterHall = z.infer<typeof hall>
/** The Steward and every Hall of a guild. */
export interface Roster {
  steward: z.infer<typeof agent>
  halls: RosterHall[]
}

/** Most pages one roster load will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

/** Loads the guild's roster for the ledger view, following the server's page cursors. */
export async function loadRoster(session: Session, fetcher: Fetcher, limit = 50): Promise<Roster> {
  const halls: RosterHall[] = []
  let steward: Roster['steward'] | null = null
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `limit=${limit}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`
    const res = await fetcher(`/api/guilds/${session.guildId}/roster?${query}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(data)
      throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
    }
    const body = page.parse(data)
    steward = body.steward
    halls.push(...body.halls)
    if (body.next === null) {
      return { steward, halls }
    }
    after = body.next
  }
  throw new Error('roster has too many pages')
}
