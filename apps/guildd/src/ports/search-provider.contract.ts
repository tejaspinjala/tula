import { describe, expect, test } from 'bun:test'
import { type SearchProvider, searchHit } from './search-provider'

/** The SearchProvider contract, run against every adapter. `make` returns a provider seeded with at least three results. */
export function searchProviderContract(name: string, make: () => Promise<SearchProvider>) {
  describe(`SearchProvider contract: ${name}`, () => {
    test('returns well-formed hits and never more than the limit', async () => {
      const provider = await make()
      const hits = await provider.search('anything', {
        limit: 2,
        signal: new AbortController().signal,
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.length).toBeLessThanOrEqual(2)
      for (const hit of hits) {
        expect(searchHit.safeParse(hit).success).toBe(true)
      }
    })

    test('names itself and says whether private Quests may use it', async () => {
      const provider = await make()
      expect(provider.id.length).toBeGreaterThan(0)
      expect(typeof provider.privateEligible).toBe('boolean')
    })
  })
}
