import { z } from 'zod'
import type { Fetcher } from '../artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from '../passkeys'
import { type BuilderConfig, parseConfig } from './model'

/** What a save or restore reports; `pending` means a widening change awaits the passkey confirm. */
export interface SaveOutcome {
  version: number
  status: 'applied' | 'pending'
  change: 'tightening' | 'neutral' | 'widening'
}

/** One validation problem the server found, with the path to the offending field. */
export interface ConfigIssue {
  path: (string | number)[]
  message: string
}

/** Thrown when the server refuses a config as invalid. */
export class SaveRejected extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super('invalid_config')
    this.name = 'SaveRejected'
  }
}

/** One row of the version history. */
export interface VersionRow {
  version: number
  status: 'applied' | 'pending'
  kind: 'seed' | 'change' | 'restore'
  change: SaveOutcome['change']
  createdAt: string
}

const change = z.enum(['tightening', 'neutral', 'widening'])
const outcomeBody = z.object({
  version: z.number(),
  status: z.enum(['applied', 'pending']),
  change,
})
const currentBody = z.object({ version: z.number(), config: z.unknown() })
const versionsBody = z.object({
  versions: z.array(
    z.object({
      version: z.number(),
      status: z.enum(['applied', 'pending']),
      kind: z.enum(['seed', 'change', 'restore']),
      change,
      createdAt: z.string(),
    })
  ),
})
const unknownKeysBody = z.object({
  error: z.literal('unknown_config_key'),
  unknownKeys: z.array(z.string()),
})
const issuesBody = z.object({
  error: z.literal('invalid_config'),
  issues: z.array(
    z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })
  ),
})

async function call<T>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>
): Promise<T> {
  const res = await fetcher(url, init)
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const rejected = issuesBody.safeParse(data)
    if (rejected.success) {
      throw new SaveRejected(rejected.data.issues)
    }
    const unknown = unknownKeysBody.safeParse(data)
    if (unknown.success) {
      throw new Error(`unknown config key: ${unknown.data.unknownKeys.join(', ')}`)
    }
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return schema.parse(data)
}

const base = (session: Session) => `/api/guilds/${session.guildId}/config`
const auth = (session: Session) => ({ authorization: `Bearer ${session.token}` })

/** Loads the config in force and its version. */
export async function loadCurrent(
  session: Session,
  fetcher: Fetcher
): Promise<{ version: number; config: BuilderConfig }> {
  const body = await call(fetcher, base(session), { headers: auth(session) }, currentBody)
  return { version: body.version, config: parseConfig(body.config) }
}

/** Saves an edited config through `PUT /guilds/:id/config`; the server classifies the change. */
export function saveConfig(
  session: Session,
  config: BuilderConfig,
  fetcher: Fetcher
): Promise<SaveOutcome> {
  return call(
    fetcher,
    base(session),
    {
      method: 'PUT',
      headers: { ...auth(session), 'content-type': 'application/json' },
      body: JSON.stringify({ config }),
    },
    outcomeBody
  )
}

/** Confirms a pending widening version after a fresh passkey re-authentication. */
export async function confirmVersion(
  session: Session,
  version: number,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<void> {
  const proof = await reauthenticate(session.token, fetcher, browser)
  await call(
    fetcher,
    `${base(session)}/versions/${version}/confirm`,
    { method: 'POST', headers: { ...auth(session), 'x-reauth-proof': proof } },
    z.unknown()
  )
}

/** Restores an earlier version as a new one (a widening restore still needs {@link confirmVersion}). */
export function restoreVersion(
  session: Session,
  version: number,
  fetcher: Fetcher
): Promise<SaveOutcome> {
  return call(
    fetcher,
    `${base(session)}/versions/${version}/restore`,
    { method: 'POST', headers: auth(session) },
    outcomeBody
  )
}

/** Loads the newest versions (one page), without their documents. */
export async function loadVersions(session: Session, fetcher: Fetcher): Promise<VersionRow[]> {
  const body = await call(
    fetcher,
    `${base(session)}/versions?limit=20`,
    { headers: auth(session) },
    versionsBody
  )
  return body.versions
}
