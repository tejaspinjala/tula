import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { type LookChoice, lookChoice } from './game/look'
import { PasskeyRequestError, type Session } from './passkeys'

const body = z.object({ look: lookChoice.nullable() })

async function read(res: Response): Promise<LookChoice | null> {
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return body.parse(data).look
}

/** Loads the Guild Master's saved look, or null when none is saved yet. */
export async function loadGuildMasterLook(
  session: Session,
  fetcher: Fetcher
): Promise<LookChoice | null> {
  return read(
    await fetcher(`/api/guilds/${session.guildId}/guild-master/look`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
  )
}

/** Saves the Guild Master's look on the server; resolves to the look it stored. */
export async function saveGuildMasterLook(
  session: Session,
  fetcher: Fetcher,
  look: LookChoice
): Promise<LookChoice> {
  const stored = await read(
    await fetcher(`/api/guilds/${session.guildId}/guild-master/look`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ look }),
    })
  )
  if (stored === null) {
    throw new PasskeyRequestError(502, 'no_look_stored')
  }
  return stored
}
