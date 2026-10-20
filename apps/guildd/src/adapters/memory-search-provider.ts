import type { SearchHit, SearchProvider, SearchRequest } from '../ports/search-provider'

/**
 * Memory adapter for {@link SearchProvider}: returns the results it was seeded with for any
 * query, and records the queries it was asked (state in this instance only). Not private-eligible
 * unless seeded so.
 */
export class MemorySearchProvider implements SearchProvider {
  readonly id = 'memory'
  readonly privateEligible: boolean
  /** Every query received, in order. */
  readonly queries: string[] = []
  private readonly results: readonly SearchHit[]

  constructor(seed: { results: readonly SearchHit[]; privateEligible?: boolean }) {
    this.results = seed.results
    this.privateEligible = seed.privateEligible ?? false
  }

  async search(query: string, request: SearchRequest): Promise<SearchHit[]> {
    this.queries.push(query)
    return this.results.slice(0, request.limit).map((r) => ({ ...r }))
  }
}
