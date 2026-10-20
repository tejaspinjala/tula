import { searchProviderContract } from '../ports/search-provider.contract'
import { MemorySearchProvider } from './memory-search-provider'

const hit = (n: number) => ({ title: `T${n}`, url: `https://e.example/${n}`, snippet: `S${n}` })

searchProviderContract(
  'memory',
  async () => new MemorySearchProvider({ results: [hit(1), hit(2), hit(3)] })
)
