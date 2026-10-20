import { useState } from 'react'

/** A long id shortened to its first eight and last four characters. */
export function shortenId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

/**
 * The guild id for the places that need it (Vault and Settings): truncated, with a button that
 * copies the whole id.
 */
export function GuildId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="guild-id">
      <span className="mono" title={id}>
        {shortenId(id)}
      </span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            ?.writeText(id)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }}
      >
        Copy guild id
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Guild id copied' : ''}
      </span>
    </span>
  )
}
