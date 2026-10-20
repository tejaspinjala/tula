import { z } from 'zod'
import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** A Quest template the Guild Master can assign from; the server holds the real ones. */
export interface AssignTemplate {
  id: string
  name: string
  hallId: string
}

/** Why a Quest could not be assigned, in words for the dialog. */
export type AssignResult = { ok: true; questId: string } | { ok: false; message: string }

/** The templates the server offers today (mirrors its code-defined list; the server decides). */
const TEMPLATES: readonly AssignTemplate[] = [
  { id: 'herald-brief', name: 'Herald brief', hallId: 'heralds' },
  { id: 'herald-announcement', name: 'Herald announcement', hallId: 'heralds' },
]

/** The templates the dialog offers for a Hall. */
export function templatesFor(hallId: string): AssignTemplate[] {
  return TEMPLATES.filter((t) => t.hallId === hallId)
}

const REFUSALS: Record<string, string> = {
  hall_locked: 'That Hall is locked.',
  hall_paused: 'That Hall is paused.',
  hall_not_found: 'That Hall does not exist.',
  unknown_template: 'That Quest template is not available.',
  unknown_owner: 'That Member cannot take this Quest.',
  rate_limited: 'Too many Quests just now. Wait a moment and try again.',
}
const FAILED = 'The Quest could not be posted. Try again.'

/** Posts a Quest to a Member through the governed Quest route; never decides anything itself. */
export async function assignQuest(
  session: Session,
  fetcher: Fetcher,
  input: { templateId: string; title: string; ownerId: string; jobKey: string }
): Promise<AssignResult> {
  try {
    const res = await fetcher(`/api/guilds/${session.guildId}/quests`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data: unknown = await res.json().catch(() => null)
    if (res.ok) {
      const quest = z.object({ id: z.string() }).safeParse(data)
      return quest.success ? { ok: true, questId: quest.data.id } : { ok: false, message: FAILED }
    }
    const error = z.object({ error: z.string() }).safeParse(data)
    return { ok: false, message: (error.success && REFUSALS[error.data.error]) || FAILED }
  } catch {
    return { ok: false, message: FAILED }
  }
}
