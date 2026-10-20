import { describe, expect, test } from 'bun:test'
import type { AdrEntry, GitHubEnvoy, MergedPull } from './github-envoy'

/** What the remote holds, per repo, for one contract run. */
export interface EnvoyWorld {
  guildId: string
  /** Repos (lower-case `owner/name`) the guild's allowlist names. */
  allowed: string[]
  repos: Record<string, { pulls: MergedPull[]; adrs: AdrEntry[] }>
}

const pull = (n: number): MergedPull => ({
  number: n,
  title: `Change ${n}`,
  body: n % 2 === 0 ? null : `why ${n}`,
  mergedAt: '2026-01-02T00:00:00Z',
  url: `https://github.com/o/r/pull/${n}`,
})
const adr: AdrEntry = { name: '0001-first.md', path: 'docs/adr/0001-first.md' }

/** The GitHubEnvoy contract, run against every adapter. `make` builds an Envoy over `world`. */
export function githubEnvoyContract(
  name: string,
  make: (world: EnvoyWorld) => Promise<GitHubEnvoy>
) {
  const world = (): EnvoyWorld => ({
    guildId: crypto.randomUUID(),
    allowed: ['o/r'],
    repos: {
      'o/r': { pulls: [pull(2), pull(1)], adrs: [adr] },
      'employer/secret': { pulls: [pull(9)], adrs: [adr] },
    },
  })

  describe(`GitHubEnvoy contract: ${name}`, () => {
    test('reads the merged pull requests and ADR names of an allowlisted repo', async () => {
      const w = world()
      const envoy = await make(w)
      expect(await envoy.mergedPulls(w.guildId, 'o/r')).toEqual([pull(2), pull(1)])
      expect(await envoy.adrEntries(w.guildId, 'o/r')).toEqual([adr])
    })

    test('a repo outside the allowlist is refused, however it is spelled', async () => {
      const w = world()
      const envoy = await make(w)
      for (const repo of ['employer/secret', 'o/other']) {
        expect(await envoy.mergedPulls(w.guildId, repo).catch((e: unknown) => e)).toMatchObject({
          code: 'not_allowlisted',
        })
        expect(await envoy.adrEntries(w.guildId, repo).catch((e: unknown) => e)).toMatchObject({
          code: 'not_allowlisted',
        })
      }
      expect(
        await envoy.mergedPulls(w.guildId, '../etc/passwd').catch((e: unknown) => e)
      ).toMatchObject({
        code: 'invalid_repo',
      })
    })
  })
}
