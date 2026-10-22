import { z } from 'zod'
import type { Fetcher } from '../artifacts'
import type { Session } from '../passkeys'
import { type Charter, charterSchema } from './schema'

/** The config outcome of an import. */
export interface ImportResult {
  config: { outcome: 'applied' | 'pending' | 'unchanged'; version: number }
  riteIds: string[]
}

/** Thrown when the server refuses a Charter export or import; `code` is its error code. */
export class CharterRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
    this.name = 'CharterRefused'
  }
}

const resultBody = z.object({
  config: z.object({
    outcome: z.enum(['applied', 'pending', 'unchanged']),
    version: z.number(),
  }),
  riteIds: z.array(z.string()),
})
const errorBody = z.object({ error: z.string() })

async function send<T>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>
): Promise<T> {
  const res = await fetcher(url, init)
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const body = errorBody.safeParse(data)
    throw new CharterRefused(res.status, body.success ? body.data.error : 'unknown')
  }
  return schema.parse(data)
}

const base = (session: Session) => `/api/guilds/${session.guildId}/charter`
const auth = (session: Session) => ({ authorization: `Bearer ${session.token}` })

/** Downloads the guild as a Charter (`GET /guilds/:id/charter`). */
export function exportCharter(session: Session, fetcher: Fetcher): Promise<Charter> {
  return send(fetcher, base(session), { headers: auth(session) }, charterSchema)
}

/** Imports a Charter (`POST /guilds/:id/charter/import`) against the config version being viewed. */
export function importCharter(
  session: Session,
  body: { charter: Charter; baseVersion: number; importId: string },
  fetcher: Fetcher
): Promise<ImportResult> {
  return send(
    fetcher,
    `${base(session)}/import`,
    {
      method: 'POST',
      headers: { ...auth(session), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    resultBody
  )
}
