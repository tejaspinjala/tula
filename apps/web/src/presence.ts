import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const presenceBody = z.object({
  away: z.boolean(),
  since: z.string().nullable(),
  until: z.string().nullable(),
})

/** The Guild Master's presence as the server reports it: a passed return time already reads as present. */
export type Presence = z.infer<typeof presenceBody>

async function call(
  session: Session,
  fetcher: Fetcher,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Presence> {
  const res = await fetcher(`/api/guilds/${session.guildId}/guild-master${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return presenceBody.parse(data)
}

/** Loads whether the Guild Master is away, and since and until when. */
export function loadPresence(session: Session, fetcher: Fetcher): Promise<Presence> {
  return call(session, fetcher, '/presence')
}

/** Marks the Guild Master away, until `until` (an ISO instant) or until they return. No Seal needed. */
export function goAway(
  session: Session,
  fetcher: Fetcher,
  until: string | null
): Promise<Presence> {
  return call(session, fetcher, '/away', { method: 'POST', body: { until } })
}

/** Returns the Guild Master: one tap, no Seal. */
export function returnHome(session: Session, fetcher: Fetcher): Promise<Presence> {
  return call(session, fetcher, '/return', { method: 'POST' })
}

/** One plain sentence about presence, for the Bag and for screen readers. */
export function describeAway(presence: Presence): string {
  if (!presence.away) {
    return 'You are here.'
  }
  if (presence.until === null) {
    return 'You are away until you return.'
  }
  return `You are away until ${new Date(presence.until).toLocaleString()}.`
}
