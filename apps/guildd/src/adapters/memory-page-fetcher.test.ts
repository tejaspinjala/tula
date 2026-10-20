import { pageFetcherContract } from '../ports/page-fetcher.contract'
import { MemoryPageFetcher } from './memory-page-fetcher'

pageFetcherContract('memory', async () => ({
  fetcher: new MemoryPageFetcher({ 'https://e.example/a': 'hello page' }),
  servedUrl: 'https://e.example/a',
  servedText: 'hello page',
  refusedUrl: 'https://e.example/missing',
}))
