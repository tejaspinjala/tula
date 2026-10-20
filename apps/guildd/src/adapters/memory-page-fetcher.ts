import type { PageFetcher } from '../ports/page-fetcher'

/** Memory adapter for {@link PageFetcher}: serves the pages it was seeded with and throws for any other URL. */
export class MemoryPageFetcher implements PageFetcher {
  private readonly pages: ReadonlyMap<string, string>

  constructor(pages: Readonly<Record<string, string>>) {
    this.pages = new Map(Object.entries(pages))
  }

  async fetch(url: string, _request: { signal: AbortSignal }): Promise<string> {
    const page = this.pages.get(url)
    if (page === undefined) {
      throw new Error('page_not_found')
    }
    return page
  }
}
