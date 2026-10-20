import { GITHUB_TOKEN_REF } from '../ports/github-envoy'
import { githubEnvoyContract } from '../ports/github-envoy.contract'
import { GitHubRestEnvoy } from './github-rest-envoy'
import { MemoryKeyProvider } from './memory-key-provider'
import { MemorySecretStore } from './memory-secret-store'

githubEnvoyContract('github rest (fake fetch)', async (world) => {
  const secrets = new MemorySecretStore(new MemoryKeyProvider())
  await secrets.add(world.guildId, GITHUB_TOKEN_REF, 'ghp_contract')
  return new GitHubRestEnvoy({
    secrets,
    isAllowed: async (_guild, repo) => world.allowed.includes(repo.toLowerCase()),
    fetch: async (url) => {
      const match = /\/repos\/([^/]+\/[^/]+)\/(pulls|contents)/.exec(url)
      const repo = world.repos[match?.[1] ?? '']
      if (!repo || !match) {
        return new Response('{}', { status: 404 })
      }
      if (match[2] === 'pulls') {
        return Response.json(
          repo.pulls.map((p) => ({
            number: p.number,
            title: p.title,
            body: p.body,
            merged_at: p.mergedAt,
            html_url: p.url,
          }))
        )
      }
      return Response.json(repo.adrs.map((a) => ({ ...a, type: 'file' })))
    },
  })
})
