import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const root = join(import.meta.dir, '..')
const claude = join(root, '.claude')

const SettingsSchema = z.object({
  env: z.record(z.string(), z.string()),
  hooks: z.record(
    z.string(),
    z.array(
      z.object({
        matcher: z.string().optional(),
        hooks: z.array(z.object({ command: z.string() }).loose()),
      })
    )
  ),
})
const settings = SettingsSchema.parse(await Bun.file(join(claude, 'settings.json')).json())

const frontmatter = (file: string) => {
  const text = readFileSync(file, 'utf8')
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  return Object.fromEntries(
    block
      .split('\n')
      .filter((l) => /^[a-z-]+:/.test(l))
      .map((l): [string, string] => {
        const i = l.indexOf(':')
        return [l.slice(0, i), l.slice(i + 1).trim()]
      })
  )
}

describe('AGENTS.md', () => {
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

  test('stays thin', () => {
    expect(agents.split('\n').length).toBeLessThanOrEqual(200)
  })

  test('every skill and agent it names exists', () => {
    for (const skill of ['batch', 'verify', 'run-check', 'review-loop']) {
      expect(existsSync(join(claude, 'skills', skill, 'SKILL.md'))).toBe(true)
      expect(agents).toContain(`\`${skill}\``)
    }
    for (const agent of ['worker', 'explorer', 'reviewer']) {
      expect(existsSync(join(claude, 'agents', `${agent}.md`))).toBe(true)
    }
  })

  test('CLAUDE.md only imports AGENTS.md', async () => {
    expect(await Bun.file(join(root, 'CLAUDE.md')).text()).toBe('@AGENTS.md\n')
  })
})

describe('agents', () => {
  test.each([
    ['worker', 'claude-sonnet-5-5'],
    ['reviewer', 'claude-sonnet-5-5'],
    ['explorer', 'claude-haiku-5-5'],
  ])('%s is pinned to %s', (name, model) => {
    expect(frontmatter(join(claude, 'agents', `${name}.md`)).model).toBe(model)
  })

  test('reviewer and explorer cannot edit files', () => {
    for (const name of ['reviewer', 'explorer']) {
      expect(frontmatter(join(claude, 'agents', `${name}.md`)).tools).not.toMatch(/Edit|Write/)
    }
  })
})

describe('settings', () => {
  test('every registered hook script exists and is executable', () => {
    const commands = Object.values(settings.hooks).flatMap((entries) =>
      entries.flatMap((e) => e.hooks.map((h) => h.command))
    )
    expect(commands.length).toBe(4)
    for (const command of commands) {
      const script = join(root, command.replace('"$CLAUDE_PROJECT_DIR"/', ''))
      expect(existsSync(script)).toBe(true)
      expect(statSync(script).mode & 0o111).not.toBe(0)
    }
  })

  test('ECC GateGuard is off for this repo (ADR-0002)', () => {
    expect(settings.env.ECC_GATEGUARD).toBe('off')
  })

  test('every hook script is registered', () => {
    const registered = JSON.stringify(settings.hooks)
    for (const f of readdirSync(join(claude, 'hooks')).filter((f) => f.endsWith('.sh'))) {
      expect(registered).toContain(`.claude/hooks/${f}`)
    }
  })
})

describe('protect-files hook', () => {
  const run = (file: string) =>
    Bun.spawnSync(['bash', join(claude, 'hooks/protect-files.sh')], {
      stdin: new TextEncoder().encode(JSON.stringify({ tool_input: { file_path: file } })),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    }).exitCode

  test.each(['bun.lock', 'src/a/../../bun.lock', '.env', 'apps/guildd/.env.local', 'x.gen.ts'])(
    'blocks %p',
    (file) => {
      expect(run(join(root, file))).toBe(2)
    }
  )

  test.each(['.env.example', 'scripts/repo-setup.ts', 'docs/adr/0009-new.md'])(
    'allows %p',
    (file) => {
      expect(run(join(root, file))).toBe(0)
    }
  )
})

describe('agent worktrees', () => {
  // The Agent tool creates worker worktrees under .claude/worktrees inside the main checkout;
  // verify run there must not lint their nested biome.json or run their tests.
  test('are ignored by git (and so by bun test) and by Biome', async () => {
    const gitignore = await Bun.file(join(root, '.gitignore')).text()
    expect(gitignore.split('\n')).toContain('.claude/worktrees/')
    const biome = z
      .object({ files: z.object({ includes: z.array(z.string()) }) })
      .parse(await Bun.file(join(root, 'biome.json')).json())
    expect(biome.files.includes).toContain('!.claude/worktrees')
  })
})

describe('type-safety shortcuts', () => {
  const tracked = Bun.spawnSync(['git', 'ls-files', '*.ts', '*.tsx'], { cwd: root })
    .stdout.toString()
    .split('\n')
    .filter((f) => f !== '' && !f.includes('node_modules') && existsSync(join(root, f)))

  const hits = (pattern: RegExp): string[] =>
    tracked.flatMap((file) =>
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []))
    )

  test.each([
    ['a double cast through unknown', /\bas\s+unknown\s+as\b/],
    ['a cast to any', /\bas\s+any\b/],
    ['a cast to never', /\bas\s+never\b/],
    ['a ts-ignore or ts-expect-error directive', /@ts-(ignore|expect-error)/],
    ['a CommonJS require call', /\brequire\(/],
    ['a biome-ignore without a reason', /biome-ignore[^:]*$|biome-ignore[^:]*:\s*$/],
  ])('no tracked source uses %s', (_name, pattern) => {
    expect(hits(pattern)).toEqual([])
  })

  test('biome makes the strict rules errors', async () => {
    const biome = z
      .object({
        linter: z.object({
          rules: z.object({
            suspicious: z.record(z.string(), z.unknown()),
            style: z.record(z.string(), z.unknown()),
            complexity: z.record(z.string(), z.unknown()),
          }),
        }),
      })
      .parse(await Bun.file(join(root, 'biome.json')).json())
    expect(biome.linter.rules.suspicious).toMatchObject({
      noExplicitAny: 'error',
      noTsIgnore: 'error',
    })
    expect(biome.linter.rules.style).toMatchObject({ noNonNullAssertion: 'error' })
    expect(biome.linter.rules.complexity).toMatchObject({ noBannedTypes: 'error' })
  })

  test('every tsconfig keeps strict, noUncheckedIndexedAccess and exactOptionalPropertyTypes', async () => {
    const rootConfig = z
      .object({
        compilerOptions: z.object({
          strict: z.literal(true),
          noUncheckedIndexedAccess: z.literal(true),
          exactOptionalPropertyTypes: z.literal(true),
        }),
      })
      .parse(await Bun.file(join(root, 'tsconfig.json')).json())
    expect(rootConfig.compilerOptions.strict).toBe(true)
    for (const app of ['guildd', 'web']) {
      const cfg = z
        .object({
          extends: z.string(),
          compilerOptions: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(await Bun.file(join(root, 'apps', app, 'tsconfig.json')).json())
      expect(cfg.extends).toBe('../../tsconfig.json')
      expect(cfg.compilerOptions).not.toMatchObject({ strict: false })
      expect(cfg.compilerOptions).not.toMatchObject({ noUncheckedIndexedAccess: false })
      expect(cfg.compilerOptions).not.toMatchObject({ exactOptionalPropertyTypes: false })
    }
  })
})
