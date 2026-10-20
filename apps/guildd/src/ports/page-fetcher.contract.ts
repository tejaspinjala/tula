import { describe, expect, test } from 'bun:test'
import type { PageFetcher } from './page-fetcher'

/** A fetcher under test, and one URL it serves with its text and one it must refuse. */
export interface PageFetcherFixture {
  fetcher: PageFetcher
  servedUrl: string
  servedText: string
  refusedUrl: string
}

/** The PageFetcher contract, run against every adapter. */
export function pageFetcherContract(name: string, make: () => Promise<PageFetcherFixture>) {
  describe(`PageFetcher contract: ${name}`, () => {
    test('returns the page text of a served URL', async () => {
      const f = await make()
      const text = await f.fetcher.fetch(f.servedUrl, { signal: new AbortController().signal })
      expect(text).toContain(f.servedText)
    })

    test('throws for a URL it cannot or may not fetch', async () => {
      const f = await make()
      await expect(
        f.fetcher.fetch(f.refusedUrl, { signal: new AbortController().signal })
      ).rejects.toThrow()
    })
  })
}
