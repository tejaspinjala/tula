import { z } from 'zod'

/** One result a search provider returns. All three fields are untrusted text from the web. */
export const searchHit = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
})
/** One search result. */
export type SearchHit = z.infer<typeof searchHit>

/** What one search call is asked for. */
export interface SearchRequest {
  /** The most results to return. */
  limit: number
  /** Aborted when the caller gives up (timeout); an adapter passes it to its outbound request. */
  signal: AbortSignal
}

/**
 * Port for a web search provider (ADR-0010). guildd, never the sandbox, calls it, and only from
 * the governed `research` tool: the Quest's cap and Treasury charge are settled first. The query
 * leaves guildd, so `privateEligible` says whether the provider may see the queries of a
 * private-class Quest; it is a property of the configured provider, never of a model's say-so.
 */
export interface SearchProvider {
  /** A short stable name for logs and events (never a secret). */
  readonly id: string
  /** True only when the provider may receive queries from private-class Quests. */
  readonly privateEligible: boolean
  /** Runs one search. Implementations may throw; the caller bounds and retries it. */
  search(query: string, request: SearchRequest): Promise<SearchHit[]>
}
