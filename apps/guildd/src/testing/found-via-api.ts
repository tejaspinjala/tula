import { z } from 'zod'
import { SoftwareAuthenticator } from './software-authenticator'

/** The slice of a harness (or app) that sends requests to guildd. */
export interface Requester {
  request: (path: string, init?: RequestInit) => Promise<Response>
}

const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const keysByGuild = new Map<string, SoftwareAuthenticator>()

/** Test-only: the virtual passkey `foundViaApi` registered for `guildId`, if it founded that guild. */
export function foundingKeyOf(guildId: string): SoftwareAuthenticator | undefined {
  return keysByGuild.get(guildId)
}

const foundedBody = z.object({ id: z.string() })

/** A guild founded through the atomic ceremony, with the virtual passkey that is its first one. */
export interface FoundedGuild {
  /** The guild id; empty when founding was refused. */
  id: string
  /** The virtual passkey registered as the Guild Master's first passkey. */
  key: SoftwareAuthenticator
  /** The last response of the ceremony (`/founding/finish`, or `/founding/begin` if refused there). */
  response: Response
}

/**
 * Test-only: founds a guild through `/founding/begin` and `/founding/finish` with a virtual
 * WebAuthn passkey, the only founding flow. `extra` headers go on both requests (a forwarded
 * address, say). The response is returned so a test can assert a refusal; `id` is empty then.
 */
export async function foundViaApi(
  harness: Requester,
  input: { name: string; goal: string },
  extra: Record<string, string> = {}
): Promise<FoundedGuild> {
  const headers = { 'content-type': 'application/json', ...extra }
  const key = await SoftwareAuthenticator.create('localhost', 'http://localhost:5173')
  const begun = await harness.request('/founding/begin', { method: 'POST', headers, body: '{}' })
  if (begun.status !== 200) {
    return { id: '', key, response: begun }
  }
  const started = ceremony.parse(await begun.json())
  const response = await harness.request('/founding/finish', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      challengeId: started.challengeId,
      response: await key.register(started.options),
      ...input,
    }),
  })
  const id = response.status === 201 ? foundedBody.parse(await response.clone().json()).id : ''
  if (id) {
    keysByGuild.set(id, key)
  }
  return { id, key, response }
}
