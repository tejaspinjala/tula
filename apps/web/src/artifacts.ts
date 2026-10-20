/** The slice of `fetch` used here; narrower than `typeof fetch`, so tests can fake it. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

/** An artifact opened from guildd. */
export interface OpenedArtifact {
  hash: string
  class: string
  size: number
  /** The bytes decoded as UTF-8 for display. */
  text: string
}

/** Result of opening an artifact: found, or a clean not-found / error. */
export type ArtifactResult =
  | { kind: 'found'; artifact: OpenedArtifact }
  | { kind: 'not_found' }
  | { kind: 'error'; status: number }

/** How the caller proves its guild: a session token, or (development only) a bare guild id. */
export type ArtifactAuth = { token: string } | { guildId: string }

/**
 * Opens the artifact `hash` through guildd's `GET /artifacts/:hash`. A session authenticates with
 * `Authorization: Bearer`; the `x-guild-id` header is only the development fallback when there is
 * no session (guildd rejects it in production).
 */
export async function openArtifact(
  hash: string,
  auth: ArtifactAuth,
  fetcher: Fetcher = fetch
): Promise<ArtifactResult> {
  const res = await fetcher(`/api/artifacts/${encodeURIComponent(hash)}`, {
    headers:
      'token' in auth ? { authorization: `Bearer ${auth.token}` } : { 'x-guild-id': auth.guildId },
  })
  if (res.status === 404) {
    return { kind: 'not_found' }
  }
  if (!res.ok) {
    return { kind: 'error', status: res.status }
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  return {
    kind: 'found',
    artifact: {
      hash,
      class: res.headers.get('x-artifact-class') ?? 'unknown',
      size: bytes.byteLength,
      text: new TextDecoder().decode(bytes),
    },
  }
}
