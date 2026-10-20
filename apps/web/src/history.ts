import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'
import type { ReplayEvent } from './replay'

const pageBody = z.object({
  events: z.array(
    z.object({ seq: z.number(), type: z.string(), payload: z.unknown(), occurredAt: z.string() })
  ),
  next: z.number().nullable(),
})

/** Most pages one load will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 40

/** Loads the guild's event log for replay, following the server's page cursors. */
export async function loadHistory(
  session: Session,
  fetcher: Fetcher,
  options: { limit?: number } = {}
): Promise<ReplayEvent[]> {
  const events: ReplayEvent[] = []
  const limit = options.limit ?? 200
  let after: number | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `limit=${limit}${after === null ? '' : `&after=${after}`}`
    const res = await fetcher(`/api/guilds/${session.guildId}/events/history?${query}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(data)
      throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
    }
    const body = pageBody.parse(data)
    events.push(...body.events)
    if (body.next === null) {
      return events
    }
    after = body.next
  }
  throw new Error('too many history pages')
}
