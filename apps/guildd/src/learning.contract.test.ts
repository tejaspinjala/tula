import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryGitHubEnvoy } from './adapters/memory-github-envoy'
import { MemoryModelProvider } from './adapters/memory-model-provider'
import { defaultConfig, isLearningRepoAllowed } from './guild-config'
import type { ConfigStore } from './ports/config-store'
import { MAX_SUGGESTION_PAGE } from './ports/suggestion-store'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const asked: string[] = []
const provider = new MemoryModelProvider()
const pull = (n: number) => ({
  number: n,
  title: `Change ${n}`,
  body: `why ${n}`,
  mergedAt: '2026-01-02T00:00:00Z',
  url: `https://github.com/o/r/pull/${n}`,
})

/** Filled once the harness exists; the Envoy's allowlist check reads the guild's real config. */
const configOf: { store?: ConfigStore } = {}
const harness = await createHarness({
  devGuildHeader: true,
  app: {
    modelProvider: provider,
    githubEnvoy: MemoryGitHubEnvoy.fromFixtures(
      {
        'o/r': {
          pulls: [pull(1), pull(2)],
          adrs: [{ name: '0001-a.md', path: 'docs/adr/0001-a.md' }],
        },
        'employer/secret': { pulls: [pull(9)], adrs: [] },
      },
      async (guildId, repo) => {
        asked.push(repo)
        const current = await configOf.store?.current(guildId)
        return current !== undefined && isLearningRepoAllowed(current.config, repo)
      }
    ),
  },
})
configOf.store = harness.adapters.config
afterAll(async () => {
  await harness.close()
})

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const suggestionBody = z.object({
  id: z.string(),
  sourceId: z.string(),
  status: z.string(),
  noteId: z.string().nullable(),
})
const pageBody = z.object({ suggestions: z.array(suggestionBody), next: z.string().nullable() })
const scanBody = z.object({ repos: z.number(), added: z.number(), failed: z.array(z.unknown()) })

function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return harness.request(path, {
    method,
    headers: { ...json, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A founded guild allowlisting `repos`, with a signed-in Guild Master session. */
async function signedIn(repos: string[] = ['o/r']) {
  const guildId = await harness.foundGuild({ name: 'Learning', goal: 'g' })
  await harness.adapters.config.seed(guildId)
  const proposed = await harness.adapters.config.propose(guildId, {
    ...defaultConfig(),
    learningRepos: repos,
  })
  if (proposed.status === 'pending') {
    await harness.adapters.config.confirm(guildId, proposed.version)
  }
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
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
  return { guildId, auth: { authorization: `Bearer ${token}` } }
}

async function list(guildId: string, auth: Record<string, string>, query = '') {
  const res = await send('GET', `/guilds/${guildId}/learning/suggestions${query}`, auth)
  return { status: res.status, body: pageBody.parse(await res.json()) }
}

describe('learning suggestion routes', () => {
  test('a scan stores suggestions; running it again adds none', async () => {
    const { guildId, auth } = await signedIn()
    const first = await send('POST', `/guilds/${guildId}/learning/scan`, auth, {})
    expect(first.status).toBe(200)
    expect(scanBody.parse(await first.json())).toMatchObject({ repos: 1, added: 3 })
    const again = await send('POST', `/guilds/${guildId}/learning/scan`, auth, {})
    expect(scanBody.parse(await again.json())).toMatchObject({ added: 0 })
    expect((await list(guildId, auth)).body.suggestions).toHaveLength(3)
    expect(asked).not.toContain('employer/secret')
  })

  test('a barred guild is not scanned: 409 gates_barred, the Envoy untouched, the bar stays', async () => {
    const { guildId, auth } = await signedIn()
    await harness.adapters.gates.bar({ guildId, memberId: crypto.randomUUID() }, 'guild')
    const before = asked.length
    const res = await send('POST', `/guilds/${guildId}/learning/scan`, auth, {})
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'gates_barred' })
    expect(asked).toHaveLength(before)
    expect(await harness.adapters.gates.status(guildId)).toEqual({ guild: true, global: false })
    expect((await list(guildId, auth)).body.suggestions).toHaveLength(0)
  })

  test('the list is paginated and capped', async () => {
    const { guildId, auth } = await signedIn()
    await send('POST', `/guilds/${guildId}/learning/scan`, auth, {})
    const one = await list(guildId, auth, '?limit=2')
    expect(one.body.suggestions).toHaveLength(2)
    expect(one.body.next).not.toBeNull()
    const two = await list(guildId, auth, `?limit=2&after=${one.body.next}`)
    expect(two.body.suggestions).toHaveLength(1)
    expect(two.body.next).toBeNull()
    expect(
      (
        await send(
          'GET',
          `/guilds/${guildId}/learning/suggestions?limit=${MAX_SUGGESTION_PAGE + 1}`,
          auth
        )
      ).status
    ).toBe(400)
    expect(
      (await send('GET', `/guilds/${guildId}/learning/suggestions?status=weird`, auth)).status
    ).toBe(400)
  })

  test('accept files an assumption note under no Hall; dismiss files none and is final', async () => {
    const { guildId, auth } = await signedIn()
    await send('POST', `/guilds/${guildId}/learning/scan`, auth, {})
    const [a, b] = (await list(guildId, auth)).body.suggestions
    const accepted = await send(
      'POST',
      `/guilds/${guildId}/learning/suggestions/${a?.id}/accept`,
      auth,
      {}
    )
    expect(accepted.status).toBe(200)
    const noteId =
      z.object({ suggestion: suggestionBody }).parse(await accepted.json()).suggestion.noteId ?? ''
    const detail = await harness.adapters.notes.get(guildId, noteId)
    expect(detail?.note.trust).toBe('quarantined')
    expect(await harness.adapters.notes.get(guildId, noteId, 'heralds')).toBeNull()
    const dismissed = await send(
      'POST',
      `/guilds/${guildId}/learning/suggestions/${b?.id}/dismiss`,
      auth,
      {}
    )
    expect(dismissed.status).toBe(200)
    expect(
      (await send('POST', `/guilds/${guildId}/learning/suggestions/${b?.id}/accept`, auth, {}))
        .status
    ).toBe(409)
    expect((await harness.adapters.notes.list(guildId, { limit: 10 })).notes).toHaveLength(1)
    await send('POST', `/guilds/${guildId}/learning/scan`, auth, {})
    expect((await list(guildId, auth, '?status=pending')).body.suggestions).toHaveLength(1)
  })

  test('scan, accept and dismiss need a real Guild Master session', async () => {
    const { guildId } = await signedIn()
    const dev = { 'x-guild-id': guildId }
    const id = crypto.randomUUID()
    for (const path of ['scan', `suggestions/${id}/accept`, `suggestions/${id}/dismiss`]) {
      expect((await send('POST', `/guilds/${guildId}/learning/${path}`, dev, {})).status).toBe(401)
      expect((await send('POST', `/guilds/${guildId}/learning/${path}`, {}, {})).status).toBe(401)
    }
  })

  test('an unknown suggestion is a 404', async () => {
    const { guildId, auth } = await signedIn()
    const id = crypto.randomUUID()
    expect(
      (await send('POST', `/guilds/${guildId}/learning/suggestions/${id}/accept`, auth, {})).status
    ).toBe(404)
    expect(
      (await send('POST', `/guilds/${guildId}/learning/suggestions/not-a-uuid/dismiss`, auth, {}))
        .status
    ).toBe(404)
  })

  test('no model is called and no usage is recorded by scanning, dismissing or accepting', async () => {
    const { guildId, auth } = await signedIn()
    await send('POST', `/guilds/${guildId}/learning/scan`, auth, {})
    const [a, b] = (await list(guildId, auth)).body.suggestions
    await send('POST', `/guilds/${guildId}/learning/suggestions/${a?.id}/accept`, auth, {})
    await send('POST', `/guilds/${guildId}/learning/suggestions/${b?.id}/dismiss`, auth, {})
    expect(provider.seen).toEqual([])
    for (const by of ['run', 'quest', 'hall', 'day'] as const) {
      expect((await harness.adapters.gateway.usage(guildId, by, { limit: 10 })).rows).toEqual([])
    }
  })
})

describe('learning routes are guild-isolated', () => {
  test('the suggestion list does not cross guilds', async () => {
    const seed = await signedIn()
    await send('POST', `/guilds/${seed.guildId}/learning/scan`, seed.auth, {})
    await expectGuildIsolation(harness, {
      build: (caller, target) => [
        `/guilds/${target}/learning/suggestions`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) =>
        (
          await harness.request(`/guilds/${guildId}/learning/suggestions`, {
            headers: { 'x-guild-id': guildId },
          })
        ).json(),
    })
  })

  test('scan, accept and dismiss aimed at another guild fail and change nothing', async () => {
    const a = await signedIn()
    const b = await signedIn()
    await send('POST', `/guilds/${b.guildId}/learning/scan`, b.auth, {})
    const target = (await list(b.guildId, b.auth)).body.suggestions[0]
    for (const path of [
      'scan',
      `suggestions/${target?.id}/accept`,
      `suggestions/${target?.id}/dismiss`,
    ]) {
      expect((await send('POST', `/guilds/${b.guildId}/learning/${path}`, a.auth, {})).status).toBe(
        404
      )
    }
    const after = (await list(b.guildId, b.auth)).body.suggestions
    expect(after.every((s) => s.status === 'pending')).toBe(true)
    expect(after).toHaveLength(3)
    expect((await list(a.guildId, a.auth)).body.suggestions).toEqual([])
  })
})
