import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { PasskeyRequestError, type Session } from './passkeys'

const pauseBody = z.object({
  id: z.string(),
  hallId: z.string(),
  tripwire: z.enum(['token_burn', 'gate_denials', 'loop', 'manual']),
  observed: z.number(),
  threshold: z.number(),
  pausedAt: z.string(),
})
const thresholdsBody = z.object({
  tokenBurnMultiple: z.number(),
  gateDenialsPerHour: z.number(),
  loopRepeats: z.number(),
})
const pageBody = z.object({
  thresholds: thresholdsBody,
  pauses: z.array(pauseBody),
  next: z.number().nullable(),
})

/** A paused Hall as the ledger view shows it. */
export type HallPauseView = z.infer<typeof pauseBody>
/** The configured Tripwire thresholds. */
export type TripwireThresholdsView = z.infer<typeof thresholdsBody>

/** Most pages one load will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

/** Loads the guild's Tripwire thresholds and every active Hall pause, following the page cursors. */
export async function loadTripwires(
  session: Session,
  fetcher: Fetcher,
  options: { limit?: number } = {}
): Promise<{ thresholds: TripwireThresholdsView | null; pauses: HallPauseView[] }> {
  const pauses: HallPauseView[] = []
  let thresholds: TripwireThresholdsView | null = null
  const limit = options.limit ?? 50
  let after: number | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `limit=${limit}${after === null ? '' : `&after=${after}`}`
    const res = await fetcher(`/api/guilds/${session.guildId}/tripwires?${query}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
    const data: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const code = z.object({ error: z.string() }).safeParse(data)
      throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
    }
    const body = pageBody.parse(data)
    thresholds = body.thresholds
    pauses.push(...body.pauses)
    if (body.next === null) {
      return { thresholds, pauses }
    }
    after = body.next
  }
  throw new Error('too many pause pages')
}

const TRIPWIRE_NAMES = {
  token_burn: 'token burn',
  gate_denials: 'repeated gate denials',
  loop: 'loop detected',
} as const

/** One line naming a paused Hall and why it was paused. */
export function describePause(pause: HallPauseView): string {
  if (pause.tripwire === 'manual') {
    return `${pause.hallId} paused by the Guild Master`
  }
  return `${pause.hallId} paused: ${TRIPWIRE_NAMES[pause.tripwire]} (${pause.observed} against ${pause.threshold})`
}
