import { describe, expect, test } from 'bun:test'
import { PageRefused } from '../ports/page-fetcher'
import { pageFetcherContract } from '../ports/page-fetcher.contract'
import { HttpPageFetcher, isPrivateAddress } from './http-page-fetcher'

const signal = new AbortController().signal
const html = (body: string, status = 200, type = 'text/html; charset=utf-8') =>
  new Response(body, { status, headers: { 'content-type': type } })
const publicDns = async () => ['93.184.216.34']

function fetcherFor(respond: (url: string) => Response, resolve = publicDns) {
  const calls: Array<{ url: string; address: string }> = []
  const fetcher = new HttpPageFetcher({
    resolve,
    transport: async (request) => {
      calls.push({ url: request.url, address: request.address })
      return respond(request.url)
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
    expect(text).toBe('Title Body & more')
  })

  test('hostile markup is stripped in linear time', async () => {
    for (const body of ['<script '.repeat(60_000), '<'.repeat(500_000), '<a '.repeat(200_000)]) {
      const { fetcher } = fetcherFor(() => html(body))
      const started = performance.now()
      await fetcher.fetch('https://e.example/a', { signal })
      expect(performance.now() - started).toBeLessThan(100)
    }
  })

  test('stops reading text once enough has been extracted', async () => {
    const fetcher = new HttpPageFetcher({
      resolve: publicDns,
      maxTextChars: 50,
      transport: async () => html(`<p>${'word '.repeat(10_000)}</p>`),
    })
    expect((await fetcher.fetch('https://e.example/a', { signal })).length).toBeLessThanOrEqual(50)
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
      'https://[::7f00:1]/a',
      'https://[64:ff9b::7f00:1]/a',
      'https://[2002:7f00:1::]/a',
      'https://[64:ff9b::a9fe:a9fe]/a',
      'https://[fec0::1]/a',
    ]) {
      const failure = await fetcher.fetch(url, { signal }).catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(PageRefused)
      expect(String(failure)).toContain('page_host_private')
    }
    expect(calls).toEqual([])
  })

  test('connects only to the address it validated, even if the name resolves differently later', async () => {
    const answers = [['93.184.216.34'], ['127.0.0.1']]
    let asked = 0
    const { fetcher, calls } = fetcherFor(
      () => html('ok'),
      async () => answers[Math.min(asked++, 1)] ?? []
    )
    await fetcher.fetch('https://rebind.example/a', { signal })
    expect(asked).toBe(1)
    expect(calls).toEqual([{ url: 'https://rebind.example/a', address: '93.184.216.34' }])
  })

  test('does not follow redirects', async () => {
    const { fetcher, calls } = fetcherFor(
      () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })
    )
    await expect(fetcher.fetch('https://e.example/a', { signal })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  test('refusals are typed so callers do not retry them; server errors are not', async () => {
    const notText = fetcherFor(() => html('MZ', 200, 'application/octet-stream')).fetcher
    expect(
      await notText.fetch('https://e.example/a', { signal }).catch((e: unknown) => e)
    ).toBeInstanceOf(PageRefused)
    const missing = fetcherFor(() => html('gone', 404)).fetcher
    expect(
      await missing.fetch('https://e.example/a', { signal }).catch((e: unknown) => e)
    ).toBeInstanceOf(PageRefused)
    const broken = fetcherFor(() => html('oops', 503)).fetcher
    const failure = await broken.fetch('https://e.example/a', { signal }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(PageRefused)
  })

  test('reads at most the byte limit', async () => {
    const fetcher = new HttpPageFetcher({
      resolve: publicDns,
      maxBytes: 100,
      transport: async () => html(`<p>${'a'.repeat(10_000)}</p>`),
    })
    const text = await fetcher.fetch('https://e.example/a', { signal })
    expect(text.length).toBeLessThanOrEqual(100)
  })
})

describe('isPrivateAddress', () => {
  test('flags loopback, private, link-local, special-use and embedded-private addresses, not public ones', () => {
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
      'fec0::1',
      '::ffff:10.0.0.1',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
      '2002:a9fe:a9fe::1',
      '2001:db8::1',
      '2001::1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
    for (const ip of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700::1111',
      '64:ff9b::808:808',
    ]) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })
})
