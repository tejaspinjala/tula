import { expect, test } from 'bun:test'
import { EnvoyError, GITHUB_TOKEN_REF } from '../ports/github-envoy'
import { GitHubRestEnvoy } from './github-rest-envoy'
import { MemoryKeyProvider } from './memory-key-provider'
import { MemorySecretStore } from './memory-secret-store'

const TOKEN = 'ghp_super_secret_token_value'
const GUILD = crypto.randomUUID()
const FORBIDDEN = ['/files', '.diff', '.patch', '/commits/', 'compare']

interface Seen {
  url: string
  init: RequestInit
}

const pulls = [
  {
    number: 3,
    title: 'Merged one',
    body: 'why',
    merged_at: '2026-01-02T00:00:00Z',
    html_url: 'https://github.com/o/r/pull/3',
  },
  {
    number: 2,
    title: 'Closed unmerged',
    body: null,
    merged_at: null,
    html_url: 'https://github.com/o/r/pull/2',
  },
]
const contents = [
  { name: '0001-first.md', path: 'docs/adr/0001-first.md', type: 'file' },
  { name: 'assets', path: 'docs/adr/assets', type: 'dir' },
]

async function setup(
  respond: (url: string, call: number) => Response | Promise<Response>,
  options: { token?: string | null; allowed?: string[]; maxAttempts?: number } = {}
) {
  const secrets = new MemorySecretStore(new MemoryKeyProvider())
  if (options.token !== null) {
    await secrets.add(GUILD, GITHUB_TOKEN_REF, options.token ?? TOKEN)
  }
  const seen: Seen[] = []
  const sleeps: number[] = []
  const envoy = new GitHubRestEnvoy({
    secrets,
    isAllowed: async (_guild, repo) => (options.allowed ?? ['o/r']).includes(repo.toLowerCase()),
    fetch: async (url, init) => {
      seen.push({ url, init })
      return respond(url, seen.length)
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  })
  return { envoy, seen, sleeps }
}

const ok = (body: unknown) => Response.json(body)

test('reads merged pull requests only, with the Vault token, a timeout and no diff endpoints', async () => {
  const { envoy, seen } = await setup(() => ok(pulls))
  const result = await envoy.mergedPulls(GUILD, 'o/r')
  expect(result).toEqual([
    {
      number: 3,
      title: 'Merged one',
      body: 'why',
      mergedAt: '2026-01-02T00:00:00Z',
      url: 'https://github.com/o/r/pull/3',
    },
  ])
  expect(seen).toHaveLength(1)
  const [call] = seen
  expect(call?.url.startsWith('https://api.github.com/repos/o/r/pulls?')).toBe(true)
  expect(new Headers(call?.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
  expect(new Headers(call?.init.headers).get('accept')).toBe('application/vnd.github+json')
  expect(call?.init.method).toBe('GET')
  expect(call?.init.signal).toBeDefined()
})

test('lists ADR file names only', async () => {
  const { envoy, seen } = await setup(() => ok(contents))
  expect(await envoy.adrEntries(GUILD, 'o/r')).toEqual([
    { name: '0001-first.md', path: 'docs/adr/0001-first.md' },
  ])
  expect(seen[0]?.url).toBe('https://api.github.com/repos/o/r/contents/docs/adr')
  expect(new Headers(seen[0]?.init.headers).get('accept')).toBe('application/vnd.github+json')
})

test('an absent docs/adr directory is an empty list', async () => {
  const { envoy } = await setup(() => new Response('{}', { status: 404 }))
  expect(await envoy.adrEntries(GUILD, 'o/r')).toEqual([])
})

test('no request URL ever names a diff, patch, files, commit or compare endpoint', async () => {
  const { envoy, seen } = await setup((url) => ok(url.includes('/pulls') ? pulls : contents))
  await envoy.mergedPulls(GUILD, 'o/r')
  await envoy.adrEntries(GUILD, 'o/r')
  expect(seen.length).toBeGreaterThan(0)
  for (const { url } of seen) {
    for (const bad of FORBIDDEN) {
      expect(url).not.toContain(bad)
    }
  }
})

test('a repo outside the allowlist is refused before any request or token read', async () => {
  const { envoy, seen } = await setup(() => ok(pulls))
  for (const repo of ['employer/secret', 'o/r2', 'O/R/../x']) {
    const failure = await envoy.mergedPulls(GUILD, repo).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(EnvoyError)
  }
  expect(await envoy.adrEntries(GUILD, 'employer/secret').catch((e: unknown) => e)).toMatchObject({
    code: 'not_allowlisted',
  })
  expect(seen).toEqual([])
})

test('a malformed repo name is refused without a request', async () => {
  const { envoy, seen } = await setup(() => ok(pulls), { allowed: ['../x', 'o/r/pulls'] })
  expect(await envoy.mergedPulls(GUILD, '../x').catch((e: unknown) => e)).toMatchObject({
    code: 'invalid_repo',
  })
  expect(await envoy.adrEntries(GUILD, 'o/r/pulls').catch((e: unknown) => e)).toMatchObject({
    code: 'invalid_repo',
  })
  expect(seen).toEqual([])
})

test('a missing token is refused without a request', async () => {
  const { envoy, seen } = await setup(() => ok(pulls), { token: null })
  expect(await envoy.mergedPulls(GUILD, 'o/r').catch((e: unknown) => e)).toMatchObject({
    code: 'token_missing',
  })
  expect(seen).toEqual([])
})

test('server errors are retried a bounded number of times with jittered backoff', async () => {
  const { envoy, seen, sleeps } = await setup((_url, call) =>
    call < 3 ? new Response('no', { status: 503 }) : ok(pulls)
  )
  expect((await envoy.mergedPulls(GUILD, 'o/r')).length).toBe(1)
  expect(seen).toHaveLength(3)
  expect(sleeps).toHaveLength(2)
  expect(sleeps.every((ms) => ms > 0)).toBe(true)

  const down = await setup(() => new Response('no', { status: 502 }), { maxAttempts: 3 })
  expect(await down.envoy.mergedPulls(GUILD, 'o/r').catch((e: unknown) => e)).toMatchObject({
    code: 'unavailable',
  })
  expect(down.seen).toHaveLength(3)
})

test('a client error is not retried, and nothing the failure carries includes the token', async () => {
  const { envoy, seen } = await setup(() => new Response(`bad ${TOKEN}`, { status: 401 }))
  const failure = await envoy.mergedPulls(GUILD, 'o/r').catch((e: unknown) => e)
  expect(failure).toBeInstanceOf(EnvoyError)
  expect(JSON.stringify(failure) + String(failure)).not.toContain(TOKEN)
  expect(seen).toHaveLength(1)
})

test('redirects are never followed: a 301 is unavailable after exactly one request', async () => {
  const { envoy, seen } = await setup(
    () => new Response(null, { status: 301, headers: { location: 'https://evil.example/steal' } })
  )
  expect(await envoy.mergedPulls(GUILD, 'o/r').catch((e: unknown) => e)).toMatchObject({
    code: 'unavailable',
  })
  expect(seen).toHaveLength(1)
  expect(seen[0]?.init.redirect).toBe('manual')
})

test('a pull request whose link is not a github.com https URL is dropped, never stored', async () => {
  const bad = (html_url: string) => ({ ...pulls[0], number: 4, html_url })
  const { envoy } = await setup(() =>
    ok([
      pulls[0],
      bad('javascript:alert(1)'),
      bad('http://github.com/o/r/pull/4'),
      bad('https://evil.example/o/r/pull/4'),
      bad('https://github.com.evil.example/x'),
    ])
  )
  expect((await envoy.mergedPulls(GUILD, 'o/r')).map((p) => p.number)).toEqual([3])
})

test('a response that does not match the schema is refused', async () => {
  const { envoy } = await setup(() => ok({ not: 'an array' }))
  expect(await envoy.mergedPulls(GUILD, 'o/r').catch((e: unknown) => e)).toMatchObject({
    code: 'bad_response',
  })
})
