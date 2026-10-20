import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const claude = join(root, '.claude')

type HookEntry = { matcher?: string; hooks: { command: string }[] }
const settings = (await Bun.file(join(claude, 'settings.json')).json()) as {
  env: Record<string, string>
  hooks: Record<string, HookEntry[]>
}

const frontmatter = (file: string) => {
  const text = require('node:fs').readFileSync(file, 'utf8') as string
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  return Object.fromEntries(
    block
      .split('\n')
      .filter((l) => /^[a-z-]+:/.test(l))
      .map((l) => {
        const i = l.indexOf(':')
        return [l.slice(0, i), l.slice(i + 1).trim()]
      })
  ) as Record<string, string>
}

describe('AGENTS.md', () => {
  const agents = require('node:fs').readFileSync(join(root, 'AGENTS.md'), 'utf8') as string

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
