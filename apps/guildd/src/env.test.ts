import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import {
  loadEnv,
  loadPlatformOperators,
  loadResearchEnv,
  loadSandboxEnv,
  loadSubscriptionEnv,
  loadVapidEnv,
  loadWebauthnEnv,
} from './env'
import { vapidKeys } from './testing/vapid-keys'

const vapidPair = vapidKeys()
const vapid = {
  VAPID_PUBLIC_KEY: vapidPair.publicKey,
  VAPID_PRIVATE_KEY: vapidPair.privateKey,
  VAPID_SUBJECT: vapidPair.subject,
}

const base = {
  APP_DATABASE_URL: 'postgres://app:pw@localhost:5432/db',
  OBJECT_STORE_ACCESS_KEY: 'access',
  OBJECT_STORE_SECRET_KEY: 'secret',
}

describe('loadEnv', () => {
  test('accepts a complete environment', () => {
    const env = loadEnv(base)
    expect(env.OBJECT_STORE_ACCESS_KEY).toBe('access')
    expect(env.OBJECT_STORE_CREATE_BUCKET).toBe(false)
  })

  test('DISPATCH_INTERVAL_MS is off by default and takes a positive integer of milliseconds', () => {
    expect(loadEnv(base).DISPATCH_INTERVAL_MS).toBeUndefined()
    expect(loadEnv({ ...base, DISPATCH_INTERVAL_MS: '5000' }).DISPATCH_INTERVAL_MS).toBe(5000)
    expect(() => loadEnv({ ...base, DISPATCH_INTERVAL_MS: '0' })).toThrow()
    expect(() => loadEnv({ ...base, DISPATCH_INTERVAL_MS: 'soon' })).toThrow()
  })

  test('TRUST_PROXY defaults to false and rejects values that are not true or false', () => {
    expect(loadEnv(base).TRUST_PROXY).toBe(false)
    expect(loadEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true)
    expect(() => loadEnv({ ...base, TRUST_PROXY: 'yes' })).toThrow()
  })

  test('FOUNDING_MODE defaults to open and accepts only open, once or closed', () => {
    expect(loadEnv(base).FOUNDING_MODE).toBe('open')
    expect(loadEnv({ ...base, FOUNDING_MODE: 'once' }).FOUNDING_MODE).toBe('once')
    expect(loadEnv({ ...base, FOUNDING_MODE: 'closed' }).FOUNDING_MODE).toBe('closed')
    expect(() => loadEnv({ ...base, FOUNDING_MODE: 'sometimes' })).toThrow()
  })

  test('throws without object store credentials', () => {
    expect(() => loadEnv({ ...base, OBJECT_STORE_ACCESS_KEY: undefined })).toThrow()
    expect(() => loadEnv({ ...base, OBJECT_STORE_SECRET_KEY: undefined })).toThrow()
  })

  test('the app environment does not carry the owner DATABASE_URL', () => {
    expect('DATABASE_URL' in loadEnv({ ...base, DATABASE_URL: 'postgres://owner@x/y' })).toBe(false)
  })

  test('production requires explicit WebAuthn settings and rejects the dev guild header', () => {
    const prod = { ...base, NODE_ENV: 'production' }
    const rp = { WEBAUTHN_RP_ID: 'guild.example', WEBAUTHN_ORIGIN: 'https://guild.example' }
    expect(() => loadEnv(prod)).toThrow()
    expect(() => loadEnv({ ...prod, WEBAUTHN_RP_ID: 'guild.example' })).toThrow()
    expect(() => loadEnv({ ...prod, ...rp, DEV_GUILD_HEADER: 'true' })).toThrow()
    expect(
      loadEnv({ ...prod, ...rp, ...vapid, KEY_FILE: '/k', CHECKPOINT_DIR: '/c' }).WEBAUTHN_ORIGIN
    ).toBe('https://guild.example')
    expect(() => loadWebauthnEnv(prod)).toThrow()
    expect(loadWebauthnEnv({ NODE_ENV: 'development' }).WEBAUTHN_RP_ID).toBe('localhost')
  })

  test('production requires an explicit KEY_FILE; development defaults it', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'guild.example',
      WEBAUTHN_ORIGIN: 'https://guild.example',
    }
    expect(() => loadEnv(prod)).toThrow(/KEY_FILE/)
    expect(
      loadEnv({ ...prod, ...vapid, KEY_FILE: '/run/keys/master.key', CHECKPOINT_DIR: '/c' })
        .KEY_FILE
    ).toBe('/run/keys/master.key')
    expect(loadEnv(base).KEY_FILE).toBe('.guildhall/master.key')
  })

  test('production requires an explicit CHECKPOINT_DIR; development defaults it', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'guild.example',
      WEBAUTHN_ORIGIN: 'https://guild.example',
      KEY_FILE: '/k',
    }
    expect(() => loadEnv(prod)).toThrow(/CHECKPOINT_DIR/)
    expect(loadEnv({ ...prod, ...vapid, CHECKPOINT_DIR: '/mnt/anchor' }).CHECKPOINT_DIR).toBe(
      '/mnt/anchor'
    )
    expect(loadEnv(base).CHECKPOINT_DIR).toBe('.guildhall/checkpoints')
  })

  test('production requires the VAPID keys and subject; development may omit all three', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'guild.example',
      WEBAUTHN_ORIGIN: 'https://guild.example',
      KEY_FILE: '/k',
      CHECKPOINT_DIR: '/c',
    }
    expect(() => loadEnv(prod)).toThrow(/VAPID_PUBLIC_KEY/)
    expect(() => loadEnv({ ...prod, ...vapid, VAPID_SUBJECT: undefined })).toThrow(/VAPID_SUBJECT/)
    expect(loadEnv({ ...prod, ...vapid }).VAPID_PUBLIC_KEY).toBe(vapid.VAPID_PUBLIC_KEY)
    expect(loadEnv(base).VAPID_PUBLIC_KEY).toBeUndefined()
  })

  test('loadVapidEnv returns the three settings, or nothing when push is unconfigured', () => {
    expect(loadVapidEnv({ NODE_ENV: 'development' })).toBeUndefined()
    expect(loadVapidEnv({ NODE_ENV: 'development', ...vapid })).toEqual({
      publicKey: vapid.VAPID_PUBLIC_KEY,
      privateKey: vapid.VAPID_PRIVATE_KEY,
      subject: vapid.VAPID_SUBJECT,
    })
    expect(() => loadVapidEnv({ NODE_ENV: 'production' })).toThrow(/VAPID_PUBLIC_KEY/)
  })

  test('VAPID keys must be well-formed P-256 keys and are all-or-none', () => {
    expect(() => loadEnv({ ...base, ...vapid, VAPID_PUBLIC_KEY: 'short' })).toThrow()
    expect(() => loadEnv({ ...base, ...vapid, VAPID_PRIVATE_KEY: 'short' })).toThrow()
    expect(() => loadEnv({ ...base, ...vapid, VAPID_SUBJECT: 'not-a-contact' })).toThrow()
    expect(() => loadEnv({ ...base, VAPID_PUBLIC_KEY: vapid.VAPID_PUBLIC_KEY })).toThrow()
    expect(loadEnv({ ...base, ...vapid }).VAPID_PRIVATE_KEY).toBe(vapid.VAPID_PRIVATE_KEY)
  })

  test('no dev credentials are baked into production source', async () => {
    const offenders: string[] = []
    for await (const file of new Glob('**/*.ts').scan({ cwd: import.meta.dir })) {
      if (file.startsWith('testing/') || file.endsWith('.test.ts')) {
        continue
      }
      const text = await Bun.file(`${import.meta.dir}/${file}`).text()
      if (text.includes('guildhall-dev-secret') || text.includes('guildhall:guildhall')) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('sandbox settings', () => {
  const docker = {
    SANDBOX_RUNNER: 'docker',
    SANDBOX_IMAGE: `guildhall-worker@sha256:${'a'.repeat(64)}`,
    SANDBOX_NETWORK: 'guildhall-sandbox',
    EGRESS_PROXY_URL: 'http://egress-proxy:3128',
    SANDBOX_GATEWAY_URL: 'http://guildd:3000',
  }
  const tls = { SANDBOX_GATEWAY_URL: 'https://guildd.example:3000' }
  test('defaults to the memory runner outside production', () => {
    expect(loadSandboxEnv({ NODE_ENV: 'development' })).toEqual({ kind: 'memory' })
  })
  test('docker needs an image pinned by digest, the network, the proxy and the gateway', () => {
    expect(loadSandboxEnv(docker)).toEqual({
      kind: 'docker',
      image: docker.SANDBOX_IMAGE,
      network: 'guildhall-sandbox',
      scope: 'default',
      killDeadlineMs: 2000,
      proxyUrl: 'http://egress-proxy:3128',
      gatewayUrl: 'http://guildd:3000',
    })
    // A locally built image is pinned by its image id.
    expect(loadSandboxEnv({ ...docker, SANDBOX_IMAGE: `sha256:${'c'.repeat(64)}` }).kind).toBe(
      'docker'
    )
    expect(() => loadSandboxEnv({ ...docker, SANDBOX_IMAGE: 'guildhall-worker:latest' })).toThrow(
      /SANDBOX_IMAGE/
    )
    expect(() => loadSandboxEnv({ ...docker, EGRESS_PROXY_URL: undefined })).toThrow(
      /EGRESS_PROXY_URL/
    )
  })
  test('the kill deadline is configurable and must be a positive number of ms', () => {
    expect(
      loadSandboxEnv({ ...docker, SANDBOX_KILL_DEADLINE_MS: '500' }).kind === 'docker' &&
        loadSandboxEnv({ ...docker, SANDBOX_KILL_DEADLINE_MS: '500' })
    ).toMatchObject({ killDeadlineMs: 500 })
    expect(() => loadSandboxEnv({ ...docker, SANDBOX_KILL_DEADLINE_MS: '0' })).toThrow(
      /SANDBOX_KILL_DEADLINE_MS/
    )
  })
  test('refuses an option-like image and a host-wide or option-like network', () => {
    expect(() =>
      loadSandboxEnv({ ...docker, SANDBOX_IMAGE: `-x@sha256:${'a'.repeat(64)}` })
    ).toThrow(/SANDBOX_IMAGE/)
    expect(() =>
      loadSandboxEnv({ ...docker, SANDBOX_IMAGE: `x y@sha256:${'a'.repeat(64)}` })
    ).toThrow(/SANDBOX_IMAGE/)
    for (const network of ['host', 'bridge', 'none', '--x', '-v']) {
      expect(() => loadSandboxEnv({ ...docker, SANDBOX_NETWORK: network })).toThrow(
        /SANDBOX_NETWORK/
      )
    }
  })
  test('production refuses an unset runner and the memory runner', () => {
    expect(() => loadSandboxEnv({ NODE_ENV: 'production' })).toThrow(/SANDBOX_RUNNER/)
    expect(() => loadSandboxEnv({ NODE_ENV: 'production', SANDBOX_RUNNER: 'memory' })).toThrow(
      /SANDBOX_RUNNER/
    )
    expect(loadSandboxEnv({ NODE_ENV: 'production', ...docker, ...tls }).kind).toBe('docker')
  })
  test('production needs an https gateway URL; the proxy may stay http on the internal network', () => {
    expect(() => loadSandboxEnv({ NODE_ENV: 'production', ...docker })).toThrow(
      /SANDBOX_GATEWAY_URL/
    )
    expect(loadSandboxEnv({ NODE_ENV: 'development', ...docker }).kind).toBe('docker')
    const loaded = loadSandboxEnv({ NODE_ENV: 'production', ...docker, ...tls })
    expect(loaded.kind === 'docker' && loaded.proxyUrl).toBe('http://egress-proxy:3128')
  })
  test('production refuses the dev guild header', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', DEV_GUILD_HEADER: 'true' })).toThrow(
      /DEV_GUILD_HEADER must not be true in production/
    )
  })
})

describe('PLATFORM_OPERATORS', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  test('is a comma-separated list of member uuids; unset or empty is an empty list', () => {
    expect(loadPlatformOperators({ PLATFORM_OPERATORS: `${a}, ${b}` })).toEqual([a, b])
    expect(loadPlatformOperators({ PLATFORM_OPERATORS: '' })).toEqual([])
    expect(loadPlatformOperators({})).toEqual([])
  })
  test('ids are lowercased and de-duplicated', () => {
    expect(loadPlatformOperators({ PLATFORM_OPERATORS: `${a.toUpperCase()},${a},${b}` })).toEqual([
      a,
      b,
    ])
  })
  test('fails at boot on anything that is not a uuid', () => {
    expect(() => loadPlatformOperators({ PLATFORM_OPERATORS: `${a},not-a-uuid` })).toThrow()
  })
})

describe('loadSubscriptionEnv', () => {
  test('is disabled by default, with the CLI on PATH, two at once and a two-minute timeout', () => {
    expect(loadSubscriptionEnv({})).toEqual({
      enabled: false,
      bin: 'claude',
      timeoutMs: 120_000,
      maxConcurrent: 2,
    })
  })

  test('reads every setting and enables only on the exact word', () => {
    expect(
      loadSubscriptionEnv({
        SUBSCRIPTION_PROVIDER: 'enabled',
        CLAUDE_CLI_BIN: '/opt/claude',
        CLAUDE_CLI_TIMEOUT_MS: '30000',
        CLAUDE_CLI_MAX_CONCURRENT: '4',
      })
    ).toEqual({ enabled: true, bin: '/opt/claude', timeoutMs: 30_000, maxConcurrent: 4 })
    expect(() => loadSubscriptionEnv({ SUBSCRIPTION_PROVIDER: 'true' })).toThrow()
    expect(() => loadSubscriptionEnv({ CLAUDE_CLI_MAX_CONCURRENT: '0' })).toThrow()
    expect(() => loadSubscriptionEnv({ CLAUDE_CLI_TIMEOUT_MS: 'soon' })).toThrow()
  })
})

describe('loadResearchEnv', () => {
  const brave = { RESEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'k' }

  test('research is off unless a provider is configured', () => {
    expect(loadResearchEnv({})).toBeNull()
  })

  test('the Brave provider needs its key; it is not private-eligible and costs one cent by default', () => {
    expect(() => loadResearchEnv({ RESEARCH_PROVIDER: 'brave' })).toThrow()
    expect(loadResearchEnv(brave)).toEqual({
      kind: 'brave',
      apiKey: 'k',
      privateEligible: false,
      costCents: 1,
    })
  })

  test('private eligibility and the per-call cost are explicit host settings', () => {
    expect(
      loadResearchEnv({
        ...brave,
        RESEARCH_PRIVATE_ELIGIBLE: 'true',
        RESEARCH_CALL_COST_CENTS: '5',
      })
    ).toMatchObject({ privateEligible: true, costCents: 5 })
    expect(() => loadResearchEnv({ ...brave, RESEARCH_PRIVATE_ELIGIBLE: 'yes' })).toThrow()
    expect(() => loadResearchEnv({ ...brave, RESEARCH_CALL_COST_CENTS: '-1' })).toThrow()
  })

  test('the memory provider needs a seed and is refused in production', () => {
    const seed = JSON.stringify({
      results: [{ title: 'T', url: 'https://e.example/a', snippet: 'S' }],
      pages: { 'https://e.example/a': 'page text' },
    })
    const memory = { RESEARCH_PROVIDER: 'memory', RESEARCH_MEMORY_SEED: seed }
    expect(() => loadResearchEnv({ RESEARCH_PROVIDER: 'memory' })).toThrow()
    expect(() => loadResearchEnv({ ...memory, RESEARCH_MEMORY_SEED: '{' })).toThrow()
    expect(loadResearchEnv(memory)).toMatchObject({ kind: 'memory', privateEligible: false })
    expect(() => loadResearchEnv({ ...memory, NODE_ENV: 'production' })).toThrow()
  })
})
