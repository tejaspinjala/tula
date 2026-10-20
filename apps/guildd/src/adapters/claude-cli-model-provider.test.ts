import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ProviderSecret } from '../ports/model-provider'
import { ClaudeCliModelProvider } from './claude-cli-model-provider'

const FAKE = `${import.meta.dir}/../testing/fake-claude.ts`
const secret = new ProviderSecret('')

const call = (mode: string) => ({
  model: 'tier-model',
  system: 'be brief',
  messages: [{ role: 'user' as const, content: `MODE=${mode}\nhello` }],
  maxTokens: 50,
})

const echo = z.object({
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  stdin: z.string(),
})

describe('ClaudeCliModelProvider', () => {
  test('returns the reply text and the reported tokens, cache tokens counted as input', async () => {
    const provider = new ClaudeCliModelProvider({ bin: FAKE })
    const out = await provider.complete(secret, call('ok'))
    expect(out).toEqual({ text: 'hello from claude', usage: { inputTokens: 16, outputTokens: 5 } })
  })

  test('runs claude -p with the pinned flags and the prompt on stdin, never in argv', async () => {
    const provider = new ClaudeCliModelProvider({ bin: FAKE })
    const out = await provider.complete(secret, call('argv'))
    const seen = echo.parse(JSON.parse(out.text))
    expect(seen.argv).toEqual([
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources',
      '',
      '--system-prompt',
      'be brief',
      '--model',
      'tier-model',
    ])
    expect(seen.argv.join(' ')).not.toContain('hello')
    expect(seen.stdin).toContain('hello')
  })

  test('the child sees only the allowlisted environment', async () => {
    const provider = new ClaudeCliModelProvider({
      bin: FAKE,
      env: {
        PATH: process.env.PATH,
        HOME: '/home/gm',
        ANTHROPIC_API_KEY: 'sk-leak',
        ANTHROPIC_AUTH_TOKEN: 'tok-leak',
        ANTHROPIC_BASE_URL: 'https://evil.example',
        VAULT_MASTER_KEY: 'guildd-secret',
        APP_DATABASE_URL: 'postgres://x',
      },
    })
    const seen = echo.parse(JSON.parse((await provider.complete(secret, call('argv'))).text))
    expect(Object.keys(seen.env).filter((k) => !k.startsWith('__'))).toEqual(
      expect.arrayContaining(['PATH', 'HOME', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'])
    )
    expect(seen.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(JSON.stringify(seen.env)).not.toContain('leak')
    expect(JSON.stringify(seen.env)).not.toContain('guildd-secret')
    expect(Object.keys(seen.env).some((k) => k.startsWith('ANTHROPIC_'))).toBe(false)
  })
})
