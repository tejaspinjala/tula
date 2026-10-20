/** Vault ref the Guild Master's GitHub token lives under; the Envoy resolves it, nothing else reads it. */
export const GITHUB_TOKEN_REF = 'github-token'

/** A merged pull request: its title and description only, never a diff. */
export interface MergedPull {
  number: number
  title: string
  body: string | null
  mergedAt: string
  url: string
}

/** One entry of a repo's `docs/adr` listing: a file name and path, never contents. */
export interface AdrEntry {
  name: string
  path: string
}

/** Why an Envoy call was refused or failed. */
export type EnvoyErrorCode =
  | 'not_allowlisted'
  | 'invalid_repo'
  | 'token_missing'
  | 'unavailable'
  | 'bad_response'

/** Thrown by a {@link GitHubEnvoy}; the message never carries the token. */
export class EnvoyError extends Error {
  constructor(readonly code: EnvoyErrorCode) {
    super(code)
    this.name = 'EnvoyError'
  }
}

/**
 * Port for the read-only GitHub Envoy. It reads merged pull request titles and descriptions and the
 * names of files under `docs/adr`, for repos on the guild's allowlist only. It has no method that
 * returns a diff, a file's contents or a commit, and none that writes.
 */
export interface GitHubEnvoy {
  /** Recently merged pull requests of `repo` (`owner/name`), newest first, at most one bounded page. */
  mergedPulls(guildId: string, repo: string): Promise<MergedPull[]>
  /** Markdown files in the repo's `docs/adr` directory; empty when the directory is absent. */
  adrEntries(guildId: string, repo: string): Promise<AdrEntry[]>
}
