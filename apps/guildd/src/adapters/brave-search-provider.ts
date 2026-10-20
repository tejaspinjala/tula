import { z } from 'zod'
import type { SearchHit, SearchProvider, SearchRequest } from '../ports/search-provider'

/** The slice of `fetch` the adapters use, so tests can stand in a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const DEFAULT_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

const answer = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.string(),
          description: z.string().default(''),
        })
      ),
    })
    .default({ results: [] }),
})

/** Settings of a {@link BraveSearchProvider}. */
export interface BraveSearchOptions {
  /** The Brave Search API subscription token. Secret: sent only as a header, never logged or put in an error. */
  apiKey: string
  /** Whether private-class Quests may send queries to it; the host decides, per its agreement with the provider. */
  privateEligible: boolean
  /** The search endpoint; defaults to Brave's. */
  endpoint?: string
  /** Replaces `fetch` in tests. */
  fetchImpl?: FetchLike
}

/**
 * {@link SearchProvider} over the Brave Search API. One GET per search, bounded by the caller's
 * abort signal. The API key travels only in a header; a failure names the HTTP status, never the key.
 */
export class BraveSearchProvider implements SearchProvider {
  readonly id = 'brave'
  readonly privateEligible: boolean
  private readonly apiKey: string
  private readonly endpoint: string
  private readonly fetchImpl: FetchLike

  constructor(options: BraveSearchOptions) {
    this.apiKey = options.apiKey
    this.privateEligible = options.privateEligible
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async search(query: string, request: SearchRequest): Promise<SearchHit[]> {
    const url = new URL(this.endpoint)
    url.searchParams.set('q', query)
    url.searchParams.set('count', String(request.limit))
    const response = await this.fetchImpl(url.href, {
      headers: { accept: 'application/json', 'x-subscription-token': this.apiKey },
      signal: request.signal,
    })
    if (!response.ok) {
      throw new Error(`brave_search_http_${response.status}`)
    }
    const parsed = answer.parse(await response.json())
    return parsed.web.results
      .slice(0, request.limit)
      .map((r) => ({ title: r.title, url: r.url, snippet: r.description }))
  }
}
