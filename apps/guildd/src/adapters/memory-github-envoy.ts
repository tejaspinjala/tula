import { type AdrEntry, EnvoyError, type GitHubEnvoy, type MergedPull } from '../ports/github-envoy'

/** What one fixture repo holds. */
export interface FixtureRepo {
  pulls: MergedPull[]
  adrs: AdrEntry[]
}

const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/**
 * Memory adapter for {@link GitHubEnvoy}: serves fixtures held in this instance, applying the same
 * allowlist check first as the REST adapter. No network, no token.
 */
export class MemoryGitHubEnvoy implements GitHubEnvoy {
  private constructor(
    private readonly repos: ReadonlyMap<string, FixtureRepo>,
    private readonly isAllowed: (guildId: string, repo: string) => Promise<boolean>
  ) {}

  /** Builds an Envoy over fixtures keyed by lower-case `owner/name`. */
  static fromFixtures(
    fixtures: Record<string, FixtureRepo>,
    isAllowed: (guildId: string, repo: string) => Promise<boolean>
  ): MemoryGitHubEnvoy {
    return new MemoryGitHubEnvoy(new Map(Object.entries(fixtures)), isAllowed)
  }

  private async repo(guildId: string, repo: string): Promise<FixtureRepo> {
    if (!REPO.test(repo)) {
      throw new EnvoyError('invalid_repo')
    }
    if (!(await this.isAllowed(guildId, repo))) {
      throw new EnvoyError('not_allowlisted')
    }
    return this.repos.get(repo.toLowerCase()) ?? { pulls: [], adrs: [] }
  }

  async mergedPulls(guildId: string, repo: string): Promise<MergedPull[]> {
    return structuredClone((await this.repo(guildId, repo)).pulls)
  }

  async adrEntries(guildId: string, repo: string): Promise<AdrEntry[]> {
    return structuredClone((await this.repo(guildId, repo)).adrs)
  }
}
