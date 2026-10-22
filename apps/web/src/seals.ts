import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from './passkeys'

const sealBody = z.object({
  id: z.string(),
  questId: z.string(),
  /** The Quest's title, so a card never has to show an id; null when the Quest is gone. */
  questTitle: z.string().nullable().optional(),
  requestedBy: z.string(),
  kind: z.string(),
  text: z.string(),
  evidence: z.string(),
  actionHash: z.string(),
  stale: z.boolean(),
  status: z.enum([
    'requested',
    'approved',
    'denied',
    'expired',
    'reserved',
    'consumed',
    'released',
    'council_approved',
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

/** The first page of Seals in `status`: waiting for the Guild Master by default. */
export function listSeals(
  session: Session,
  fetcher: Fetcher,
  limit = 20,
  status: 'requested' | 'approved' | 'reserved' = 'requested'
) {
  return call(session, fetcher, `?status=${status}&limit=${limit}`, pageBody)
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

/**
 * Records that the Guild Master posted the approved text by hand. The server hashes `text` and
 * compares it with the sealed hash. A stale reservation needs a fresh passkey re-authentication.
 */
export async function markPosted(
  session: Session,
  seal: Pick<InboxSeal, 'id' | 'text' | 'stale'>,
  fetcher: Fetcher,
  browser?: PasskeyBrowser
) {
  const proof =
    seal.stale && browser ? await reauthenticate(session.token, fetcher, browser) : undefined
  return call(session, fetcher, `/${seal.id}/posted`, sealBody, {
    method: 'POST',
    body: { text: seal.text },
    ...(proof === undefined ? {} : { proof }),
  })
}

/** Frees a stale reservation (nothing was published) after a fresh passkey re-authentication. */
export async function releaseStale(
  session: Session,
  seal: Pick<InboxSeal, 'id'>,
  fetcher: Fetcher,
  browser: PasskeyBrowser
) {
  const proof = await reauthenticate(session.token, fetcher, browser)
  return call(session, fetcher, `/${seal.id}/release-stale`, sealBody, {
    method: 'POST',
    body: {},
    proof,
  })
}

/** The Seal id a push notification deep-linked to (`?seal=<id>`), or null when absent or malformed. */
export function sealIdFromSearch(search: string): string | null {
  const parsed = z.uuid().safeParse(new URLSearchParams(search).get('seal'))
  return parsed.success ? parsed.data : null
}

/** One Seal by id, for a deep link from a push notification. */
export function getSeal(session: Session, id: string, fetcher: Fetcher): Promise<InboxSeal> {
  return call(session, fetcher, `/${id}`, sealBody)
}

/** A Seal's evidence split into its lead (the words before the first colon) and its checks. */
export function parseEvidence(evidence: string): { lead: string | null; items: string[] } {
  const colon = evidence.indexOf(':')
  const lead = colon > 0 ? evidence.slice(0, colon).trim() : null
  const body = colon > 0 ? evidence.slice(colon + 1) : evidence
  return {
    lead,
    items: body
      .split(';')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  }
}

/** The word the inbox shows for a Seal status: `consumed` reads `posted`, `council_approved` reads as the Council's approval. */
export function sealStatusLabel(status: string): string {
  if (status === 'council_approved') {
    return 'approved by the Council'
  }
  return status === 'consumed' ? 'posted' : status
}
