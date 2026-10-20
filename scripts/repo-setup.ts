/**
 * Applies the repository settings and the rulesets in `.github/rulesets/` to GitHub.
 * Needs admin rights on the repo; run once by the Guild Master, and again after editing a ruleset.
 * Usage: `bun run repo:setup [owner/repo]` (defaults to the `origin` remote).
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/** Repository settings the git-flow in docs/REPO-SETUP.md depends on. */
export const REPO_SETTINGS = {
  default_branch: 'develop',
  allow_merge_commit: true,
  allow_squash_merge: false,
  allow_rebase_merge: false,
  allow_auto_merge: false,
  delete_branch_on_merge: true,
  security_and_analysis: {
    secret_scanning: { status: 'enabled' },
    secret_scanning_push_protection: { status: 'enabled' },
  },
} as const

/** Directory holding one JSON file per ruleset, named by its `name` field. */
export const RULESETS_DIR = join(import.meta.dir, '..', '.github', 'rulesets')

/** A ruleset file's contents; only `name` is read here, the rest is sent to GitHub as-is. */
export const RulesetFileSchema = z.looseObject({ name: z.string() })
export type RulesetFile = z.infer<typeof RulesetFileSchema>

const ExistingRulesetsSchema = z.array(z.object({ id: z.number(), name: z.string() }))

/** Reads every ruleset JSON file in {@link RULESETS_DIR}. */
export async function loadRulesets(): Promise<RulesetFile[]> {
  const files = readdirSync(RULESETS_DIR).filter((f) => f.endsWith('.json'))
  return Promise.all(
    files.map((f) =>
      Bun.file(join(RULESETS_DIR, f))
        .json()
        .then((json) => RulesetFileSchema.parse(json))
    )
  )
}

function gh(args: string[], input?: string): string {
  const proc = Bun.spawnSync(['gh', ...args], {
    stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    throw new Error(
      `gh ${args.join(' ')} failed (exit ${proc.exitCode}): ${proc.stderr.toString()}`
    )
  }
  return proc.stdout.toString()
}

async function main(): Promise<void> {
  const repo =
    process.argv[2] ??
    gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()

  gh(['api', '--method', 'PATCH', `repos/${repo}`, '--input', '-'], JSON.stringify(REPO_SETTINGS))
  console.log(`settings applied to ${repo}`)

  const existing = ExistingRulesetsSchema.parse(JSON.parse(gh(['api', `repos/${repo}/rulesets`])))
  for (const ruleset of await loadRulesets()) {
    const match = existing.find((r) => r.name === ruleset.name)
    const [method, path] = match
      ? ['PUT', `repos/${repo}/rulesets/${match.id}`]
      : ['POST', `repos/${repo}/rulesets`]
    gh(['api', '--method', method, path, '--input', '-'], JSON.stringify(ruleset))
    console.log(`${match ? 'updated' : 'created'} ruleset "${ruleset.name}"`)
  }
}

if (import.meta.main) {
  await main()
}
