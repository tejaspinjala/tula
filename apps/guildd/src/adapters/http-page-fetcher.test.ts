import { describe, expect, test } from 'bun:test'
import { pageFetcherContract } from '../ports/page-fetcher.contract'
import { HttpPageFetcher, isPrivateAddress } from './http-page-fetcher'

const signal = new AbortController().signal
const html = (body: string, status = 200, type = 'text/html; charset=utf-8') =>
  new Response(body, { status, headers: { 'content-type': type } })
const publicDns = async () => ['93.184.216.34']

function fetcherFor(respond: (url: string) => Response, resolve = publicDns) {
  const calls: Array<{ url: string; redirect: string | undefined }> = []
  const fetcher = new HttpPageFetcher({
    resolve,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), redirect: init?.redirect })
      return respond(String(input))
    },
  })
  return { fetcher, calls }
}

pageFetcherContract('http', async () => ({
  fetcher: fetcherFor((url) =>
    url.endsWith('/a') ? html('<html><body><p>hello page</p></body></html>') : html('gone', 404)
  ).fetcher,
  servedUrl: 'https://e.example/a',
  servedText: 'hello page',
  refusedUrl: 'https://e.example/missing',
}))

describe('HttpPageFetcher', () => {
  test('strips scripts, styles and tags, leaving the readable text', async () => {
    const { fetcher } = fetcherFor(() =>
      html('<style>p{}</style><script>alert(1)</script><h1>Title</h1><p>Body &amp; more</p>')
    )
    const text = await fetcher.fetch('https://e.example/a', { signal })
    expect(text).toContain('Title')
    expect(text).toContain('Body & more')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('<')
  })

  test('refuses anything but https, before any request', async () => {
    const { fetcher, calls } = fetcherFor(() => html('x'))
    await expect(fetcher.fetch('http://e.example/a', { signal })).rejects.toThrow()
    await expect(fetcher.fetch('file:///etc/passwd', { signal })).rejects.toThrow()
    expect(calls).toEqual([])
  })

  test('refuses localhost, private literals and hosts that resolve to private addresses', async () => {
    const { fetcher, calls } = fetcherFor(
      () => html('x'),
      async () => ['10.0.0.5']
    )
    for (const url of [
      'https://localhost/a',
      'https://127.0.0.1/a',
      'https://[::1]/a',
      'https://192.168.1.1/a',
      'https://169.254.169.254/latest/meta-data',
      'https://internal.example/a',
    ]) {
      await expect(fetcher.fetch(url, { signal })).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  test('does not follow redirects', async () => {
    const { fetcher, calls } = fetcherFor(
      () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })
    )
    await expect(fetcher.fetch('https://e.example/a', { signal })).rejects.toThrow()
    expect(calls).toEqual([{ url: 'https://e.example/a', redirect: 'manual' }])
  })

  test('refuses a non-text content type', async () => {
    const { fetcher } = fetcherFor(() => html('MZ', 200, 'application/octet-stream'))
    await expect(fetcher.fetch('https://e.example/a', { signal })).rejects.toThrow()
  })

  test('reads at most the byte limit', async () => {
    const fetcher = new HttpPageFetcher({
      resolve: publicDns,
      maxBytes: 100,
      fetchImpl: async () => html(`<p>${'a'.repeat(10_000)}</p>`),
    })
    const text = await fetcher.fetch('https://e.example/a', { signal })
    expect(text.length).toBeLessThanOrEqual(100)
  })
})

describe('isPrivateAddress', () => {
  test('flags loopback, private, link-local and mapped addresses, not public ones', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })
})
