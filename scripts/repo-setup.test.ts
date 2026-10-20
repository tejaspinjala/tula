import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod'
import { loadRulesets, REPO_SETTINGS } from './repo-setup'

const root = join(import.meta.dir, '..')

const ProtectionSchema = z.object({
  bypass_actors: z.array(z.unknown()),
  conditions: z.object({ ref_name: z.object({ include: z.array(z.string()) }) }),
  rules: z.array(
    z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).optional() })
  ),
})

const ChecksSchema = z.object({
  rules: z.array(
    z.object({
      type: z.string(),
      parameters: z
        .object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() })
        .optional(),
    })
  ),
})

describe('rulesets', () => {
  test('protect main and develop from deletion, force-push and direct push', async () => {
    const [ruleset] = await loadRulesets()
    expect(ruleset?.name).toBe('Protect main and develop')
    const r = ProtectionSchema.parse(ruleset)
    expect(r.conditions.ref_name.include.sort()).toEqual(['refs/heads/develop', 'refs/heads/main'])
    expect(r.bypass_actors).toEqual([])
    const types = r.rules.map((x) => x.type)
    expect(types).toEqual(
      expect.arrayContaining([
        'deletion',
        'non_fast_forward',
        'pull_request',
        'required_status_checks',
      ])
    )
    const pr = r.rules.find((x) => x.type === 'pull_request')?.parameters
    expect(pr?.allowed_merge_methods).toEqual(['merge'])
  })

  test('every required check is a job name in ci.yml', async () => {
    const [ruleset] = await loadRulesets()
    const { rules } = ChecksSchema.parse(ruleset)
    const checks = rules
      .find((x) => x.type === 'required_status_checks')
      ?.parameters?.required_status_checks?.map((c) => c.context)
    expect(checks).toEqual(['verify', 'pr-rules'])
    const ci = await Bun.file(join(root, '.github/workflows/ci.yml')).text()
    for (const check of checks ?? []) {
      expect(ci).toContain(`name: ${check}\n`)
    }
  })
})

describe('repo settings', () => {
  test('merge commits only, branches deleted after merge, develop is default', () => {
    expect(REPO_SETTINGS).toMatchObject({
      default_branch: 'develop',
      allow_merge_commit: true,
      allow_squash_merge: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
    })
  })
})

describe('commit-msg hook', () => {
  const run = (subject: string) => {
    const file = join(import.meta.dir, `.commit-msg-${crypto.randomUUID()}`)
    Bun.write(file, `${subject}\n`)
    const proc = Bun.spawnSync(['sh', join(root, '.husky/commit-msg'), file])
    Bun.spawnSync(['rm', '-f', file])
    return proc.exitCode
  }

  test.each([
    'feat: add quest engine',
    'fix(seal): reject expired seals',
    'chore!: drop node',
    "Merge branch 'develop'",
  ])('accepts %p', (subject) => {
    expect(run(subject)).toBe(0)
  })

  test.each(['add quest engine', 'Feat: capitalised', 'feature: wrong type'])(
    'rejects %p',
    (subject) => {
      expect(run(subject)).toBe(1)
    }
  )
})
