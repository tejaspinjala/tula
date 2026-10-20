import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser'
import { z } from 'zod'
import type { Fetcher } from './artifacts'

/** The browser's passkey ceremonies; injected so the flows run without a real authenticator. */
export interface PasskeyBrowser {
  /** Creates a passkey from guildd's creation options; resolves to the JSON to send back. */
  create(options: PublicKeyCredentialCreationOptionsJSON): Promise<unknown>
  /** Signs guildd's request options with a passkey; resolves to the JSON to send back. */
  get(options: PublicKeyCredentialRequestOptionsJSON): Promise<unknown>
}

function ceremonyOf<T extends { challenge: string }>() {
  return z.object({
    challengeId: z.string(),
    options: z.custom<T>(
      (v) =>
        typeof v === 'object' && v !== null && 'challenge' in v && typeof v.challenge === 'string'
    ),
  })
}
const creation = ceremonyOf<PublicKeyCredentialCreationOptionsJSON>()
const request = ceremonyOf<PublicKeyCredentialRequestOptionsJSON>()
const sessionBody = z.object({ token: z.string(), guildId: z.string() })
const proofBody = z.object({ proof: z.string() })

/** A signed-in session as the ledger view holds it. */
export type Session = z.infer<typeof sessionBody>

/** Thrown when guildd refuses a step; `status` is the HTTP status. */
export class PasskeyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`${status} ${code}`)
    this.name = 'PasskeyRequestError'
  }
}

async function send<T>(
  fetcher: Fetcher,
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  token?: string,
  proof?: string,
  foundingToken?: string
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  if (proof) {
    headers['x-reauth-proof'] = proof
  }
  if (foundingToken) {
    headers['x-founding-token'] = foundingToken
  }
  const res = await fetcher(`/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return schema.parse(data)
}

/**
 * Registers a passkey for `guildId`. The first passkey needs the one-time `foundingToken`; adding another needs the
 * session `token` and a re-authentication `proof` (a sensitive action).
 */
export async function registerPasskey(
  guildId: string,
  auth: { token: string; proof: string } | undefined,
  fetcher: Fetcher,
  browser: PasskeyBrowser,
  foundingToken?: string
): Promise<void> {
  const base = `/guilds/${guildId}/passkeys`
  const begin = await send(
    fetcher,
    `${base}/begin`,
    {},
    creation,
    auth?.token,
    auth?.proof,
    foundingToken
  )
  const response = await browser.create(begin.options)
  await send(fetcher, `${base}/finish`, { challengeId: begin.challengeId, response }, z.unknown())
}

/** Signs in to `guildId` with a passkey and returns the guild-bound session. */
export async function signIn(
  guildId: string,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<Session> {
  const base = `/guilds/${guildId}/sign-in`
  const begin = await send(fetcher, `${base}/begin`, {}, request)
  const response = await browser.get(begin.options)
  return send(fetcher, `${base}/finish`, { challengeId: begin.challengeId, response }, sessionBody)
}

/** Re-authenticates the session with the passkey and returns the short-lived proof. */
export async function reauthenticate(
  token: string,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<string> {
  const begin = await send(fetcher, '/session/reauth/begin', {}, request, token)
  const response = await browser.get(begin.options)
  const done = await send(
    fetcher,
    '/session/reauth/finish',
    { challengeId: begin.challengeId, response },
    proofBody,
    token
  )
  return done.proof
}

const foundedBody = z.object({ id: z.string(), foundingToken: z.string() })

/** Founds a guild; the one-time `foundingToken` it returns authorises the first passkey. */
export async function foundGuild(
  name: string,
  goal: string,
  fetcher: Fetcher
): Promise<z.infer<typeof foundedBody>> {
  return send(fetcher, '/guilds', { name, goal }, foundedBody)
}

/** The real browser ceremonies, backed by the platform WebAuthn implementation. */
export const webAuthnBrowser: PasskeyBrowser = {
  create: (optionsJSON) => startRegistration({ optionsJSON }),
  get: (optionsJSON) => startAuthentication({ optionsJSON }),
}

/** Signs in with a discoverable passkey and no guild id; the guild comes from the passkey. */
export async function signInWithPasskey(
  _fetcher: Fetcher,
  _browser: PasskeyBrowser
): Promise<Session> {
  throw new Error('not implemented')
}

/** Whether guildd is open to founding a guild (`GET /founding`); a failed call reads as closed. */
export async function foundingOpen(_fetcher: Fetcher): Promise<boolean> {
  throw new Error('not implemented')
}

/** The signed-in guild's name and id (`GET /guilds/:id` with the session token). */
export async function fetchGuild(
  _session: Session,
  _fetcher: Fetcher
): Promise<{ id: string; name: string }> {
  throw new Error('not implemented')
}
