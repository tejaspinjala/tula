import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from './passkeys'

const statusBody = z.object({ guild: z.boolean(), global: z.boolean(), operator: z.boolean() })
const barBody = z.object({
  barId: z.string(),
  scope: z.enum(['guild', 'global']),
  created: z.boolean(),
  revokedRuns: z.number(),
  killedSandboxes: z.number(),
})

/** Which bars are up for the signed-in guild. */
export type GatesStatus = z.infer<typeof statusBody>
/** What barring stopped. */
export type BarResult = z.infer<typeof barBody>

function path(session: Session, scope: 'guild' | 'global', action: 'bar' | 'lift'): string {
  return scope === 'global'
    ? `/api/gates/${action}`
    : `/api/guilds/${session.guildId}/gates/${action}`
}

async function call<T>(
  fetcher: Fetcher,
  url: string,
  schema: z.ZodType<T>,
  init: { method: 'GET' | 'POST'; token: string; proof?: string }
): Promise<T> {
  const res = await fetcher(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${init.token}`,
      ...(init.proof === undefined ? {} : { 'x-reauth-proof': init.proof }),
    },
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return schema.parse(data)
}

/** Reads which bars are up. */
export function loadGates(session: Session, fetcher: Fetcher): Promise<GatesStatus> {
  return call(fetcher, `/api/guilds/${session.guildId}/gates`, statusBody, {
    method: 'GET',
    token: session.token,
  })
}

/** Bars the Gates for the guild or every guild; immediate, no re-authentication. */
export function barGates(
  session: Session,
  scope: 'guild' | 'global',
  fetcher: Fetcher
): Promise<BarResult> {
  return call(fetcher, path(session, scope, 'bar'), barBody, {
    method: 'POST',
    token: session.token,
  })
}

/** Lifts the bar after a fresh passkey re-authentication. */
export async function liftGates(
  session: Session,
  scope: 'guild' | 'global',
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<void> {
  const proof = await reauthenticate(session.token, fetcher, browser)
  await call(fetcher, path(session, scope, 'lift'), z.object({ barred: z.literal(false) }), {
    method: 'POST',
    token: session.token,
    proof,
  })
}

/** One sentence describing the bars. */
export function describeGates(status: Pick<GatesStatus, 'guild' | 'global'>): string {
  if (status.global) {
    return 'The Gates are barred for every guild.'
  }
  return status.guild ? 'The Gates are barred for this guild.' : 'The Gates are open.'
}
