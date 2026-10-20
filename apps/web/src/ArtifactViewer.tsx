import { useState } from 'react'
import { type ArtifactResult, openArtifact } from './artifacts'
import type { Session } from './passkeys'

/**
 * Minimal artifact viewer: opens a stored artifact by hash and shows its class, size and text.
 * Signed in, it authenticates with the session token; the guild id box is a development fallback.
 */
export function ArtifactViewer({ session }: { session: Session | null }) {
  const [guildId, setGuildId] = useState('')
  const [hash, setHash] = useState('')
  const [result, setResult] = useState<ArtifactResult | null>(null)

  return (
    <section className="mt-8">
      <h2 id="artifact-heading" className="text-xl font-semibold">
        Artifact viewer
      </h2>
      <form
        className="mt-4 flex flex-col gap-2"
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
            className="rounded border p-2"
            placeholder="Guild id (development only; sign in instead)"
            value={guildId}
            onChange={(event) => setGuildId(event.target.value)}
          />
        )}
        <input
          className="rounded border p-2 font-mono"
          placeholder="Artifact hash (sha-256)"
          value={hash}
          onChange={(event) => setHash(event.target.value)}
        />
        <button className="rounded bg-black p-2 text-white" type="submit">
          Open artifact
        </button>
      </form>
      {result?.kind === 'found' && (
        <article className="mt-4">
          <p>
            class: {result.artifact.class} - {result.artifact.size} bytes
          </p>
          <pre className="mt-2 overflow-auto rounded border p-2">{result.artifact.text}</pre>
        </article>
      )}
      {result?.kind === 'not_found' && <p className="mt-4">Artifact not found.</p>}
      {result?.kind === 'error' && <p className="mt-4">Could not open the artifact.</p>}
    </section>
  )
}
