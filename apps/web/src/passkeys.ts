import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser'
import { z } from 'zod'
import type { Fetcher } from './artifacts'

/** The browser's passkey ceremonies; injected so the flows run without a real authenticator. */
export interface PasskeyBrowser {
  /** Creates a passkey from guildd's creation options; resolves to the JSON to send back. */
  create(options: PublicKeyCredentialCreationOptionsJSON, signal?: AbortSignal): Promise<unknown>
  /** Signs guildd's request options with a passkey; resolves to the JSON to send back. */
  get(options: PublicKeyCredentialRequestOptionsJSON, signal?: AbortSignal): Promise<unknown>
}

/** How long a passkey ceremony may wait for the authenticator before it is cut off (55 s).
 * Strictly shorter than guildd's 60 s WebAuthn timeout so the client line wins over the browser's own NotAllowedError. */
export const CEREMONY_TIMEOUT_MS = 55_000

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
const sessionBody = z.object({ token: z.string().default(''), guildId: z.string() })
/** Asks guildd for a cookie session: the token travels only in an HttpOnly cookie. */
const COOKIE_MODE = { 'x-session-mode': 'cookie' }
const proofBody = z.object({ proof: z.string() })

/**
 * A signed-in session as the ledger view holds it. The browser's `token` is always empty: the
 * session lives in an HttpOnly cookie that scripts cannot read and fetch sends by itself (an
 * empty `Bearer` header is ignored by guildd, which then uses the cookie).
 */
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
  foundingToken?: string,
  extra: Record<string, string> = {},
  signal?: AbortSignal
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  if (proof) {
    headers['x-reauth-proof'] = proof
  }
  if (foundingToken) {
    headers['x-founding-token'] = foundingToken
  }
  const res = await fetcher(`/api${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: signal ?? null,
  })
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
  return send(
    fetcher,
    `${base}/finish`,
    { challengeId: begin.challengeId, response },
    sessionBody,
    undefined,
    undefined,
    undefined,
    COOKIE_MODE
  )
}

/** The pattern of an enrolment token: `<guild id>.<random>`, as guildd mints it. */
const ENROL_TOKEN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{16,}$/i

/** The enrolment token a link carries in its fragment (`#enrol=<token>`), or null. */
export function enrolTokenFromHash(hash: string): string | null {
  const found = /^#enrol=(.+)$/.exec(hash)?.[1]
  return found && ENROL_TOKEN.test(found) ? found : null
}

/** The slice of `window` that reading and clearing the fragment needs. */
export interface EnrolPlace {
  location: { hash: string; pathname: string; search: string }
  history: { replaceState(state: unknown, title: string, url: string): void }
}

/**
 * Reads the enrolment token from the address bar's fragment and removes the fragment at once, so
 * the token is not left in the address bar, history entries or a copied URL. Null when absent.
 */
export function takeEnrolToken(place: EnrolPlace): string | null {
  const token = enrolTokenFromHash(place.location.hash)
  if (token) {
    place.history.replaceState(null, '', `${place.location.pathname}${place.location.search}`)
  }
  return token
}

/**
 * Enrols this device: registers one discoverable passkey with the one-time `token` from a link
 * minted on the host, and returns the guild-bound cookie session. The token goes in a request
 * header, never a URL.
 */
export async function enrolPasskey(
  token: string,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<Session> {
  const guildId = ENROL_TOKEN.exec(token)?.[1]
  if (!guildId) {
    throw new PasskeyRequestError(401, 'registration_closed')
  }
  const base = `/guilds/${guildId}/enrol`
  const begin = await send(
    fetcher,
    `${base}/begin`,
    {},
    creation,
    undefined,
    undefined,
    undefined,
    {
      'x-enrol-token': token,
    }
  )
  const response = await browser.create(begin.options)
  return send(
    fetcher,
    `${base}/finish`,
    { challengeId: begin.challengeId, response },
    sessionBody,
    undefined,
    undefined,
    undefined,
    COOKIE_MODE
  )
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

/** Lets an abort signal cancel the library's pending ceremony, which takes no signal itself. */
function cancelOnAbort(signal?: AbortSignal): void {
  signal?.addEventListener('abort', () => WebAuthnAbortService.cancelCeremony(), { once: true })
}

/** The real browser ceremonies, backed by the platform WebAuthn implementation. */
export const webAuthnBrowser: PasskeyBrowser = withNoPasskeyDetection(
  withCeremonyTimeout({
    create: (optionsJSON, signal) => {
      cancelOnAbort(signal)
      return startRegistration({ optionsJSON })
    },
    get: (optionsJSON, signal) => {
      cancelOnAbort(signal)
      return startAuthentication({ optionsJSON })
    },
  })
)

/** Signs in with a discoverable passkey and no guild id; the guild comes from the passkey. */
export async function signInWithPasskey(
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<Session> {
  const begin = await send(fetcher, '/sign-in/begin', {}, request)
  const response = await browser.get(begin.options)
  return send(
    fetcher,
    '/sign-in/finish',
    { challengeId: begin.challengeId, response },
    sessionBody,
    undefined,
    undefined,
    undefined,
    COOKIE_MODE
  )
}

/** The session the cookie still names after a reload (`GET /session`), or null when signed out. */
export async function restoreSession(fetcher: Fetcher): Promise<Session | null> {
  try {
    const res = await fetcher('/api/session')
    const parsed = sessionBody.safeParse(await res.json().catch(() => null))
    return res.ok && parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Ends the session on guildd (revoked server-side, cookie cleared); a failed call still signs out here. */
export async function endSession(fetcher: Fetcher): Promise<void> {
  try {
    await fetcher('/api/session/logout', { method: 'POST' })
  } catch {
    // The page is signed out regardless; the session also lapses on its own.
  }
}

/** Whether founding is `open`, `closed`, or `busy` (guildd answered 429: try again shortly). */
export type FoundingState = 'open' | 'closed' | 'busy'

/** Reads `GET /founding`; a failed call reads as closed, a 429 as busy. */
export async function foundingOpen(fetcher: Fetcher): Promise<FoundingState> {
  try {
    const res = await fetcher('/api/founding')
    if (res.status === 429) {
      return 'busy'
    }
    const parsed = z.object({ open: z.boolean() }).safeParse(await res.json().catch(() => null))
    return res.ok && parsed.success && parsed.data.open ? 'open' : 'closed'
  } catch {
    return 'closed'
  }
}

const guildBody = z.object({ id: z.string(), name: z.string() })

/** The signed-in guild's name and id (`GET /guilds/:id` with the session token). */
export async function fetchGuild(
  session: Session,
  fetcher: Fetcher
): Promise<{ id: string; name: string }> {
  const res = await fetcher(`/api/guilds/${session.guildId}`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  if (!res.ok) {
    throw new PasskeyRequestError(res.status, 'guild_unavailable')
  }
  return guildBody.parse(await res.json())
}

/** What went wrong in a passkey step, for choosing the in-world line. */
export type PasskeyFailure =
  | 'cancelled'
  | 'no_credential'
  | 'wrong_address'
  | 'refused'
  | 'busy'
  | 'timeout'
  | 'unknown'

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
}

/**
 * Classifies a passkey failure. A refused step from guildd is `refused` (`busy` for a 429). In the
 * browser, a `SecurityError` (or simplewebauthn's invalid-RP-ID code) means the page address does
 * not match the passkey's relying party; `NoPasskeyOffered` is an instant NotAllowedError (see
 * `withNoPasskeyDetection`); any other NotAllowedError or abort is the Guild Master cancelling.
 */
export function passkeyFailure(error: unknown): PasskeyFailure {
  if (error instanceof PasskeyRequestError) {
    return error.status === 429 ? 'busy' : 'refused'
  }
  const cause = error instanceof Error ? error.cause : undefined
  const names = [nameOf(error), nameOf(cause)]
  if (names.includes('CeremonyTimeout')) {
    return 'timeout'
  }
  if (names.includes('NoPasskeyOffered')) {
    return 'no_credential'
  }
  if (names.includes('SecurityError') || codeOf(error) === 'ERROR_INVALID_RP_ID') {
    return 'wrong_address'
  }
  if (names.includes('NotAllowedError') || names.includes('AbortError')) {
    return 'cancelled'
  }
  return 'unknown'
}

const LINES: Record<PasskeyFailure, { 'sign-in': string; founding: string; enrol: string }> = {
  cancelled: {
    'sign-in': 'You set the passkey aside. Try again when you are ready.',
    founding: 'You set the passkey aside. Try again to finish founding your guild.',
    enrol: 'You set the passkey aside. Try the link again when you are ready.',
  },
  no_credential: {
    'sign-in':
      'No passkey was offered for this address, or you set it aside at once. Open the Hall at the address you founded it from, or use an older passkey with a guild id.',
    founding:
      'Your device offered no way to make a passkey for this address, or you set it aside at once. Try the address you will use every day.',
    enrol:
      'Your device offered no way to make a passkey for this address. Open the link in the browser you will use every day.',
  },
  wrong_address: {
    'sign-in':
      'This address is not the one your passkey was made for. Open the Hall at its usual address and try again.',
    founding:
      'This address cannot hold a passkey. Open the Hall at its usual address and try again.',
    enrol: 'This address cannot hold a passkey. Open the link exactly as the host printed it.',
  },
  refused: {
    'sign-in': 'The Hall gates stayed shut: that passkey was not accepted.',
    founding: 'The Hall would not take that. Check the founding details and try again.',
    enrol:
      "This link has been used, has run out, or was never the Hall's. Ask the host for a new one.",
  },
  busy: {
    'sign-in': 'Too many knocks at the gate. Wait a minute, then try again.',
    founding: 'Too many knocks at the gate. Wait a minute, then try again.',
    enrol: 'Too many knocks at the gate. Wait a minute, then try again.',
  },
  timeout: {
    'sign-in': 'The passkey prompt timed out. Try again when you are ready.',
    founding: 'The passkey prompt timed out. Try again to finish founding your guild.',
    enrol: 'The passkey prompt timed out. Try again from the link.',
  },
  unknown: {
    'sign-in': 'Something went wrong at the gate. Try again.',
    founding: 'Founding your guild failed. Try again.',
    enrol: 'Something went wrong at the gate. Try the link again.',
  },
}

/** The in-world line for a failure at a step; every failure kind has its own wording. */
export function passkeyLine(kind: PasskeyFailure, step: 'sign-in' | 'founding' | 'enrol'): string {
  return LINES[kind][step]
}

/** An instant NotAllowedError is the browser having no passkey to offer, not the user cancelling. */
const INSTANT_MS = 600

function detecting<T>(
  ceremony: (options: T) => Promise<unknown>,
  now: () => number
): (options: T) => Promise<unknown> {
  return async (options) => {
    const started = now()
    try {
      return await ceremony(options)
    } catch (error) {
      if (nameOf(error) === 'NotAllowedError' && now() - started < INSTANT_MS) {
        const offered = new Error('No passkey was offered', { cause: error })
        offered.name = 'NoPasskeyOffered'
        throw offered
      }
      throw error
    }
  }
}

/**
 * Wraps a browser so a sign-in the browser rejects within moments reads as `NoPasskeyOffered`
 * (no discoverable passkey for this address) rather than a cancel. Registration is left alone.
 */
export function withNoPasskeyDetection(
  browser: PasskeyBrowser,
  now: () => number = () => performance.now()
): PasskeyBrowser {
  return {
    create: browser.create,
    get: detecting(browser.get, now),
  }
}

function bounded<T>(
  ceremony: (options: T, signal?: AbortSignal) => Promise<unknown>,
  ms: number
): (options: T) => Promise<unknown> {
  return (options) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        const error = new Error('The passkey prompt timed out')
        error.name = 'CeremonyTimeout'
        reject(error)
      }, ms)
    })
    return Promise.race([ceremony(options, controller.signal), timeout]).finally(() =>
      clearTimeout(timer)
    )
  }
}

/**
 * Wraps a browser so a ceremony that never settles (a webview that cannot reach an authenticator
 * answers nothing, ever) is aborted through an `AbortController` after `ms` and fails as
 * `CeremonyTimeout`, which `passkeyFailure` reads as `timeout`: never an endless spinner.
 */
export function withCeremonyTimeout(
  browser: PasskeyBrowser,
  ms: number = CEREMONY_TIMEOUT_MS
): PasskeyBrowser {
  return { create: bounded(browser.create, ms), get: bounded(browser.get, ms) }
}

/** True when the page runs inside the Guildhall desktop shell (the user-agent suffix it sets). */
export function isDesktopShell(userAgent: string): boolean {
  return /\bGuildhallDesktop\b/.test(userAgent)
}

/** The shell's state: random base64url, at least 128 bits. */
const SHELL_STATE = /^[A-Za-z0-9_-]{22,128}$/

/** The state the desktop shell put in the sign-in page address (`?state=`), or null when absent or malformed. */
export function desktopStateFromSearch(search: string): string | null {
  const state = new URLSearchParams(search).get('state')
  return state !== null && SHELL_STATE.test(state) ? state : null
}

/** True when the page was opened by the desktop shell to sign in (`?desktop=1&state=...`). */
export function desktopRequested(search: string): boolean {
  return (
    new URLSearchParams(search).get('desktop') === '1' && desktopStateFromSearch(search) !== null
  )
}

/** The desktop code and state a deep link delivered in the fragment, or null. */
export function desktopCodeFromHash(hash: string): { code: string; state: string } | null {
  const found = /^#desktop-code=([^&]+)&desktop-state=([^&]+)$/.exec(hash)
  const code = found?.[1]
  const state = found?.[2]
  return code && state && ENROL_TOKEN.test(code) && SHELL_STATE.test(state) ? { code, state } : null
}

/** Reads the desktop code and state from the address bar and clears the fragment. Null when absent. */
export function takeDesktopCode(place: EnrolPlace): { code: string; state: string } | null {
  const found = desktopCodeFromHash(place.location.hash)
  if (found) {
    place.history.replaceState(null, '', `${place.location.pathname}${place.location.search}`)
  }
  return found
}

/** The url that hands a hand-off `code` and the shell's `state` to the desktop app through the OS. */
export function desktopReturnUrl(code: string, state: string): string {
  return `guildhall://signed-in#code=${code}&state=${state}`
}

const handoffBody = z.object({ code: z.string() })

/** Mints a hand-off code for the signed-in browser session (the cookie rides along). */
export async function beginDesktopHandoff(fetcher: Fetcher, state: string): Promise<string> {
  return (await send(fetcher, '/auth/desktop/begin', { state }, handoffBody)).code
}

/** Exchanges a desktop hand-off code for a cookie session, over TLS in the body, never a URL. */
export async function exchangeDesktopCode(
  code: string,
  state: string,
  fetcher: Fetcher,
  signal?: AbortSignal
): Promise<Session> {
  return send(
    fetcher,
    '/auth/desktop/exchange',
    { code, state },
    sessionBody,
    undefined,
    undefined,
    undefined,
    COOKIE_MODE,
    signal
  )
}
