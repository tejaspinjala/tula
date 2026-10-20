import { z } from 'zod'
import {
  type AdrEntry,
  EnvoyError,
  type EnvoyErrorCode,
  GITHUB_TOKEN_REF,
  type GitHubEnvoy,
  type MergedPull,
} from '../ports/github-envoy'
import type { SecretStore } from '../ports/secret-store'
import type { FetchLike } from './anthropic-model-provider'

/** Options for {@link GitHubRestEnvoy}. */
export interface GitHubRestOptions {
  /** The Vault the token is resolved from (internal `resolve`; the value is never logged). */
  secrets: SecretStore
  /** Whether `repo` is on the guild's allowlist; asked before any request or token read. */
  isAllowed: (guildId: string, repo: string) => Promise<boolean>
  /** Defaults to global `fetch`. */
  fetch?: FetchLike
  /** API origin; defaults to GitHub's. */
  baseUrl?: string
  /** Milliseconds before one attempt is abandoned; defaults to 10000. */
  timeoutMs?: number
  /** Attempts per call, first included; defaults to 3. */
  maxAttempts?: number
  /** Backoff base in milliseconds; defaults to 500. */
  backoffMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Jitter source in [0, 1); injectable for tests. */
  random?: () => number
}

const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const MAX_BACKOFF_MS = 10_000
/** Most pull requests read per scan: one bounded page, never a walk of the whole history. */
const PULL_PAGE = 50

const pullsReply = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    html_url: z.string(),
  })
)
const contentsReply = z.array(z.object({ name: z.string(), path: z.string(), type: z.string() }))

/**
 * Read-only GitHub {@link GitHubEnvoy} over REST. It requests two endpoints only: the repo's closed
 * pull requests list (titles and descriptions) and the `docs/adr` directory listing (file names).
 * No diff, file, commit or compare endpoint is ever built. Each attempt has a timeout; rate-limit,
 * timeout and 5xx failures are retried a bounded number of times with full-jitter backoff. Replies
 * are Zod-validated and failures carry a code only, never the token or GitHub's text.
 */
export class GitHubRestEnvoy implements GitHubEnvoy {
  private readonly fetcher: FetchLike
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(private readonly options: GitHubRestOptions) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init))
    this.baseUrl = options.baseUrl ?? 'https://api.github.com'
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxAttempts = options.maxAttempts ?? 3
    this.backoffMs = options.backoffMs ?? 500
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms))
    this.random = options.random ?? Math.random
  }

  async mergedPulls(guildId: string, repo: string): Promise<MergedPull[]> {
    const res = await this.get(
      guildId,
      repo,
      `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PULL_PAGE}`
    )
    const data = pullsReply.safeParse(res.body)
    if (!data.success) {
      throw new EnvoyError('bad_response')
    }
    return data.data.flatMap((p) =>
      p.merged_at
        ? [
            {
              number: p.number,
              title: p.title,
              body: p.body ?? null,
              mergedAt: p.merged_at,
              url: p.html_url,
            },
          ]
        : []
    )
  }

  async adrEntries(guildId: string, repo: string): Promise<AdrEntry[]> {
    const res = await this.get(guildId, repo, `/repos/${repo}/contents/docs/adr`)
    if (res.status === 404) {
      return []
    }
    const data = contentsReply.safeParse(res.body)
    if (!data.success) {
      throw new EnvoyError('bad_response')
    }
    return data.data
      .filter((e) => e.type === 'file' && e.name.toLowerCase().endsWith('.md'))
      .map((e) => ({ name: e.name, path: e.path }))
  }

  /** Checks the repo, resolves the token, then GETs `path` with retries; the allowlist comes first. */
  private async get(
    guildId: string,
    repo: string,
    path: string
  ): Promise<{ status: number; body: unknown }> {
    if (!REPO.test(repo)) {
      throw new EnvoyError('invalid_repo')
    }
    if (!(await this.options.isAllowed(guildId, repo))) {
      throw new EnvoyError('not_allowlisted')
    }
    const token = await this.options.secrets.resolve(guildId, GITHUB_TOKEN_REF)
    if (token === null) {
      throw new EnvoyError('token_missing')
    }
    let code: EnvoyErrorCode = 'unavailable'
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const outcome = await this.attempt(`${this.baseUrl}${path}`, token)
      if ('body' in outcome) {
        return outcome
      }
      code = outcome.code
      if (!outcome.retry || attempt === this.maxAttempts) {
        break
      }
      const ceiling = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** (attempt - 1))
      await this.sleep(Math.max(1, Math.floor(this.random() * ceiling)))
    }
    throw new EnvoyError(code)
  }

  private async attempt(
    url: string,
    token: string
  ): Promise<{ status: number; body: unknown } | { code: EnvoyErrorCode; retry: boolean }> {
    let res: Response
    try {
      res = await this.fetcher(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'guildhall-envoy',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return { code: 'unavailable', retry: true }
    }
    if (res.status === 404) {
      return { status: 404, body: null }
    }
    if (!res.ok) {
      const retry = res.status === 429 || res.status === 408 || res.status >= 500
      return { code: 'unavailable', retry }
    }
    const body: unknown = await res.json().catch(() => null)
    return { status: res.status, body }
  }
}
