import { describe, expect, test } from 'bun:test'
import { searchProviderContract } from '../ports/search-provider.contract'
import { BraveSearchProvider } from './brave-search-provider'

const body = {
  web: {
    results: [1, 2, 3].map((n) => ({
      title: `T${n}`,
      url: `https://e.example/${n}`,
      description: `S${n}`,
    })),
  },
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
const signal = new AbortController().signal

searchProviderContract(
  'brave',
  async () =>
    new BraveSearchProvider({
      apiKey: 'k',
      privateEligible: false,
      fetchImpl: async () => json(body),
    })
)

describe('BraveSearchProvider', () => {
  test('sends the key as a header and the query and limit as parameters', async () => {
    const seen: Array<{ url: string; key: string | null }> = []
    const provider = new BraveSearchProvider({
      apiKey: 'secret-key',
      privateEligible: false,
      fetchImpl: async (input, init) => {
        seen.push({
          url: String(input),
          key: new Headers(init?.headers).get('x-subscription-token'),
        })
        return json(body)
      },
    })
    await provider.search('bun runtime', { limit: 2, signal })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.key).toBe('secret-key')
    expect(seen[0]?.url).toContain('q=bun+runtime')
    expect(seen[0]?.url).toContain('count=2')
    expect(seen[0]?.url).not.toContain('secret-key')
  })

  test('a non-200 answer throws without echoing the key', async () => {
    const provider = new BraveSearchProvider({
      apiKey: 'secret-key',
      privateEligible: false,
      fetchImpl: async () => json({ error: 'nope' }, 429),
    })
    const failure = await provider.search('q', { limit: 2, signal }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain('429')
    expect(String(failure)).not.toContain('secret-key')
  })

  test('an answer of the wrong shape throws', async () => {
    const provider = new BraveSearchProvider({
      apiKey: 'k',
      privateEligible: false,
      fetchImpl: async () => json({ web: 'nope' }),
    })
    await expect(provider.search('q', { limit: 2, signal })).rejects.toThrow()
  })
})
