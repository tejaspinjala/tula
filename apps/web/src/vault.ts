import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from './passkeys'

const listBody = z.object({ refs: z.array(z.string()), next: z.string().nullable() })
const checkBody = z.object({
  results: z.array(z.object({ ref: z.string(), status: z.enum(['resolved', 'missing']) })),
})
const addBody = z.object({ ref: z.string() })

/** Whether a secret reference resolves in the guild's Vault. */
export type SecretCheck = z.infer<typeof checkBody>['results'][number]

async function call<T>(
  fetcher: Fetcher,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>
): Promise<T> {
  const res = await fetcher(`/api${path}`, init)
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return schema.parse(data)
}

/**
 * Adds a provider key to the Vault after a fresh passkey re-authentication. The value is sent
 * once and never kept or returned; only the secret's ref comes back.
 */
export async function addSecret(
  session: Session,
  ref: string,
  value: string,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<string> {
  const proof = await reauthenticate(session.token, fetcher, browser)
  const added = await call(
    fetcher,
    `/guilds/${session.guildId}/vault/secrets`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
        'x-reauth-proof': proof,
      },
      body: JSON.stringify({ ref, value }),
    },
    addBody
  )
  return added.ref
}

/**
 * Adds a secret and then calls `clear` whether the add succeeded or failed, so the typed value
 * never lingers in the form after it has been sent.
 */
export async function submitSecret(
  session: Session,
  ref: string,
  value: string,
  fetcher: Fetcher,
  browser: PasskeyBrowser,
  clear: () => void
): Promise<string> {
  try {
    return await addSecret(session, ref, value, fetcher, browser)
  } finally {
    clear()
  }
}

/** Lists the first page of secret refs (never values). */
export function listSecrets(session: Session, fetcher: Fetcher, limit = 50) {
  return call(
    fetcher,
    `/guilds/${session.guildId}/vault/secrets?limit=${limit}`,
    { headers: { authorization: `Bearer ${session.token}` } },
    listBody
  )
}

/** Asks whether each secret ref resolves. */
export async function checkSecrets(
  session: Session,
  refs: string[],
  fetcher: Fetcher
): Promise<SecretCheck[]> {
  const body = await call(
    fetcher,
    `/guilds/${session.guildId}/vault/check`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ refs }),
    },
    checkBody
  )
  return body.results
}
