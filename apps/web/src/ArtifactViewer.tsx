import { useState } from 'react'
import { type ArtifactResult, openArtifact } from './artifacts'
import type { Session } from './passkeys'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/** Whether text reads as code (JSON, or mostly indented or brace-and-semicolon lines) rather than prose. */
function looksLikeCode(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2) {
    return false
  }
  const codey = lines.filter((line) => /^(\s{2,}|\t)|[{};]\s*$|^\s*[\]}]/.test(line)).length
  return codey / lines.length >= 0.5
}

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
          <section aria-label="Artifact text" className="artifact-reader">
            {looksLikeCode(result.artifact.text) ? (
              <pre className="artifact-code">{result.artifact.text}</pre>
            ) : (
              <p className="artifact-prose">{result.artifact.text}</p>
            )}
          </section>
        </article>
      )}
      {result?.kind === 'not_found' && <p>Artifact not found.</p>}
      {result?.kind === 'error' && <p>Could not open the artifact.</p>}
    </WorkSection>
  )
}
