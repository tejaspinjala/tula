import { describe, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryConfigStore } from './adapters/memory-config-store'
import { MemoryGitHubEnvoy } from './adapters/memory-github-envoy'
import { MemoryNoteStore } from './adapters/memory-note-store'
import { MemorySuggestionStore } from './adapters/memory-suggestion-store'
import { defaultConfig, isLearningRepoAllowed } from './guild-config'
import { LearningEngine } from './learning-engine'
import { EnvoyError, type GitHubEnvoy } from './ports/github-envoy'

const GUILD = crypto.randomUUID()
const pull = (n: number) => ({
  number: n,
  title: `Change ${n}`,
  body: `why ${n}`,
  mergedAt: '2026-01-02T00:00:00Z',
  url: `https://github.com/o/r/pull/${n}`,
})

async function setup(repos: string[], envoyOverride?: GitHubEnvoy) {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  await config.seed(GUILD)
  const proposed = await config.propose(GUILD, { ...defaultConfig(), learningRepos: repos })
  if (proposed.status === 'pending') {
    await config.confirm(GUILD, proposed.version)
  }
  const reads: string[] = []
  const inner = MemoryGitHubEnvoy.fromFixtures(
    {
      'o/r': {
        pulls: [pull(1), pull(2)],
        adrs: [{ name: '0001-a.md', path: 'docs/adr/0001-a.md' }],
      },
      'employer/secret': { pulls: [pull(9)], adrs: [] },
    },
    async (_guild, repo) => {
      reads.push(repo)
      return isLearningRepoAllowed((await config.current(GUILD)).config, repo)
    }
  )
  const store = new MemorySuggestionStore(clock)
  const notes = new MemoryNoteStore()
  const engine = new LearningEngine({ store, envoy: envoyOverride ?? inner, config, notes })
  return { engine, store, notes, reads }
}

describe('LearningEngine', () => {
  test('a scan reads the allowlisted repos and stores suggestions, once', async () => {
    const { engine, store } = await setup(['o/r'])
    expect(await engine.scan(GUILD)).toEqual({ repos: 1, added: 3, failed: [] })
    expect(await engine.scan(GUILD)).toEqual({ repos: 1, added: 0, failed: [] })
    expect((await store.list(GUILD, { limit: 10 })).suggestions).toHaveLength(3)
  })

  test('a scan never asks the Envoy about a repo outside the allowlist', async () => {
    const { engine, reads } = await setup(['o/r'])
    await engine.scan(GUILD)
    expect(new Set(reads)).toEqual(new Set(['o/r']))
  })

  test('with no allowlist, a scan reads nothing', async () => {
    const { engine, reads, store } = await setup([])
    expect(await engine.scan(GUILD)).toEqual({ repos: 0, added: 0, failed: [] })
    expect(reads).toEqual([])
    expect((await store.list(GUILD, { limit: 10 })).suggestions).toEqual([])
  })

  test('one repo failing does not stop the others, and is reported by code', async () => {
    const failing: GitHubEnvoy = {
      mergedPulls: async (_g, repo) => {
        if (repo === 'o/bad') {
          throw new EnvoyError('unavailable')
        }
        return [pull(1)]
      },
      adrEntries: async () => [],
    }
    const { engine } = await setup(['o/bad', 'o/r'], failing)
    expect(await engine.scan(GUILD)).toEqual({
      repos: 2,
      added: 1,
      failed: [{ repo: 'o/bad', code: 'unavailable' }],
    })
  })

  test('accepting files an assumption note under no Hall, and records the note', async () => {
    const { engine, store, notes } = await setup(['o/r'])
    await engine.scan(GUILD)
    const first = (await store.list(GUILD, { limit: 1 })).suggestions[0]
    const result = await engine.accept(GUILD, first?.id ?? '')
    expect(result.ok).toBe(true)
    const stored = await store.get(GUILD, first?.id ?? '')
    expect(stored?.status).toBe('accepted')
    const noteId = stored?.noteId ?? ''
    const detail = await notes.get(GUILD, noteId)
    expect(detail?.note).toMatchObject({ trust: 'quarantined', kind: 'text', title: first?.title })
    expect(detail?.note.body).toContain(first?.url ?? 'missing')
    // hall_id null: the Guild Master's own note, invisible to any Hall-scoped read.
    expect(await notes.get(GUILD, noteId, 'heralds')).toBeNull()
    expect((await notes.list(GUILD, { limit: 10 })).notes).toHaveLength(1)
  })

  test('accepting twice creates one note; dismissing creates none and is final', async () => {
    const { engine, store, notes } = await setup(['o/r'])
    await engine.scan(GUILD)
    const [a, b] = (await store.list(GUILD, { limit: 10 })).suggestions
    await Promise.all([engine.accept(GUILD, a?.id ?? ''), engine.accept(GUILD, a?.id ?? '')])
    expect((await notes.list(GUILD, { limit: 10 })).notes).toHaveLength(1)
    expect(await engine.dismiss(GUILD, b?.id ?? '')).toMatchObject({ ok: true })
    expect(await engine.accept(GUILD, b?.id ?? '')).toEqual({
      ok: false,
      reason: 'already_decided',
    })
    expect((await notes.list(GUILD, { limit: 10 })).notes).toHaveLength(1)
    await engine.scan(GUILD)
    expect((await store.list(GUILD, { limit: 10, status: 'pending' })).suggestions).toHaveLength(1)
  })

  test('a note that cannot be written leaves the suggestion pending', async () => {
    const { engine, store, notes } = await setup(['o/r'])
    await engine.scan(GUILD)
    const id = (await store.list(GUILD, { limit: 1 })).suggestions[0]?.id ?? ''
    notes.add = async () => {
      throw new Error('archive down')
    }
    await expect(engine.accept(GUILD, id)).rejects.toThrow('archive down')
    expect((await store.get(GUILD, id))?.status).toBe('pending')
  })
})
