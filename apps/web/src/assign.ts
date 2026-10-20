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

/** The templates the dialog offers for a Hall. */
export function templatesFor(_hallId: string): AssignTemplate[] {
  return []
}

/** Posts a Quest to a Member through the governed Quest route; never decides anything itself. */
export async function assignQuest(
  _session: Session,
  _fetcher: Fetcher,
  _input: { templateId: string; title: string; ownerId: string; jobKey: string }
): Promise<AssignResult> {
  return { ok: false, message: '' }
}
