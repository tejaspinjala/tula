import { afterAll, expect, test } from 'bun:test'
import { defaultConfig } from './guild-config'
import type { GitHubEnvoy } from './ports/github-envoy'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

let reads = 0
const envoy: GitHubEnvoy = {
  mergedPulls: async () => {
    reads += 1
    return []
  },
  adrEntries: async () => [],
}
const LIMIT = 2
const harness = await createHarness({
  // Rate-limit counters persist in the shared test database, keyed by window: a window of our own
  // keeps reruns from inheriting a previous run's count.
  now: new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 1_000_000) * 60_000),
  app: {
    githubEnvoy: envoy,
    rateLimits: {
      ...UNLIMITED_RATE_LIMITS,
      'learning-scan': { client: { limit: LIMIT, windowMs: 60_000 } },
    },
  },
})
afterAll(async () => {
  await harness.close()
})

test('scans are rate limited: the extra scan is a 429 with Retry-After and reads nothing', async () => {
  const guildId = await harness.foundGuild({ name: 'Rate', goal: 'g' })
  await harness.adapters.config.seed(guildId)
  const proposed = await harness.adapters.config.propose(guildId, {
    ...defaultConfig(),
    learningRepos: ['o/r'],
  })
  if (proposed.status === 'pending') {
    await harness.adapters.config.confirm(guildId, proposed.version)
  }
  const key = await SoftwareAuthenticator.create('localhost', 'http://localhost:5173')
  const founding = await harness.adapters.identity.issueFoundingToken(guildId)
  const reg = await harness.adapters.identity.beginRegistration(guildId, {
    foundingToken: founding.token,
  })
  await harness.adapters.identity.finishRegistration(
    guildId,
    reg.challengeId,
    await key.register(reg.options)
  )
  const sign = await harness.adapters.identity.beginSignIn(guildId)
  const { token } = await harness.adapters.identity.finishSignIn(
    guildId,
    sign.challengeId,
    await key.assert(sign.options)
  )
  const scan = () =>
    harness.request(`/guilds/${guildId}/learning/scan`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    })
  for (let i = 0; i < LIMIT; i++) {
    expect((await scan()).status).toBe(200)
  }
  const readsBefore = reads
  const refused = await scan()
  expect(refused.status).toBe(429)
  expect(refused.headers.get('retry-after')).not.toBeNull()
  expect(reads).toBe(readsBefore)
})
