import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from './passkeys'

const sealBody = z.object({
  id: z.string(),
  questId: z.string(),
  requestedBy: z.string(),
  kind: z.string(),
  text: z.string(),
  evidence: z.string(),
  actionHash: z.string(),
  status: z.enum([
    'requested',
    'approved',
    'denied',
    'expired',
    'reserved',
    'consumed',
    'released',
  ]),
  requestedAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
})
const pageBody = z.object({ seals: z.array(sealBody), next: z.string().nullable() })

/** A Seal as the inbox shows it: the exact Proposal text, its evidence and the hash it is bound to. */
export type InboxSeal = z.infer<typeof sealBody>

async function call<T>(
  session: Session,
  fetcher: Fetcher,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; proof?: string } = {}
): Promise<T> {
  const res = await fetcher(`/api/guilds/${session.guildId}/seals${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.proof === undefined ? {} : { 'x-reauth-proof': init.proof }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return schema.parse(data)
}

/** The first page of Seals waiting for the Guild Master. */
export function listSeals(session: Session, fetcher: Fetcher, limit = 20) {
  return call(session, fetcher, `?status=requested&limit=${limit}`, pageBody)
}

/**
 * Stamps (approves) or denies a Seal after a fresh passkey re-authentication. The decision is
 * bound to the hash the Guild Master was shown; a denial may carry a note for the revision Quest.
 */
export async function decideSeal(
  session: Session,
  seal: Pick<InboxSeal, 'id' | 'actionHash'>,
  verdict: 'approved' | 'denied',
  note: string | undefined,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<InboxSeal> {
  const proof = await reauthenticate(session.token, fetcher, browser)
  return call(
    session,
    fetcher,
    `/${seal.id}/${verdict === 'approved' ? 'approve' : 'deny'}`,
    sealBody,
    {
      method: 'POST',
      body: { actionHash: seal.actionHash, ...(note ? { note } : {}) },
      proof,
    }
  )
}

/** Records that the Guild Master posted the approved text by hand. */
export function markPosted(
  session: Session,
  seal: Pick<InboxSeal, 'id' | 'actionHash'>,
  fetcher: Fetcher
) {
  return call(session, fetcher, `/${seal.id}/posted`, sealBody, {
    method: 'POST',
    body: { actionHash: seal.actionHash },
  })
}
