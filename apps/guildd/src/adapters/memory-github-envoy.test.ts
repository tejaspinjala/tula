import { githubEnvoyContract } from '../ports/github-envoy.contract'
import { MemoryGitHubEnvoy } from './memory-github-envoy'

githubEnvoyContract('memory', async (world) =>
  MemoryGitHubEnvoy.fromFixtures(world.repos, async (_guild, repo) =>
    world.allowed.includes(repo.toLowerCase())
  )
)
