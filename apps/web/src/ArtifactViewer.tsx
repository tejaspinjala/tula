import { useState } from 'react'
import { type ArtifactResult, openArtifact } from './artifacts'
import type { Session } from './passkeys'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/**
 * Minimal artifact viewer: opens a stored artifact by hash and shows its class, size and text.
 * Signed in, it authenticates with the session token; the guild id box is a development fallback.
 */
export function ArtifactViewer({ session }: { session: Session | null }) {
  const [guildId, setGuildId] = useState('')
  const [hash, setHash] = useState('')
  const [result, setResult] = useState<ArtifactResult | null>(null)

  return (
    <WorkSection id="artifact" title="Artifact viewer">
      <form
        className="work-body"
        onSubmit={(event) => {
          event.preventDefault()
          openArtifact(
            hash.trim(),
            session ? { token: session.token } : { guildId: guildId.trim() }
          )
            .then(setResult)
            .catch(() => setResult({ kind: 'error', status: 0 }))
        }}
      >
        {!session && (
          <input
            aria-label="Guild id"
            placeholder="Guild id (development only; sign in instead)"
            value={guildId}
            onChange={(event) => setGuildId(event.target.value)}
          />
        )}
        <input
          aria-label="Artifact hash"
          className="mono"
          placeholder="Artifact hash (sha-256)"
          value={hash}
          onChange={(event) => setHash(event.target.value)}
        />
        <PixelButton type="submit">Open artifact</PixelButton>
      </form>
      {result?.kind === 'found' && (
        <article className="work-body">
          <p>
            class: {result.artifact.class} - {result.artifact.size} bytes
          </p>
          <pre className="work-log">{result.artifact.text}</pre>
        </article>
      )}
      {result?.kind === 'not_found' && <p>Artifact not found.</p>}
      {result?.kind === 'error' && <p>Could not open the artifact.</p>}
    </WorkSection>
  )
}
