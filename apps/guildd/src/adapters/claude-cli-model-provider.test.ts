import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ModelProviderError, ProviderSecret } from '../ports/model-provider'
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

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof ModelProviderError) {
      return e.code
    }
    throw e
  }
  return 'resolved'
}

const window = z.object({ start: z.number(), end: z.number() })

describe('ClaudeCliModelProvider concurrency cap', () => {
  const run = async (provider: ClaudeCliModelProvider, n: number) =>
    (await Promise.all(Array.from({ length: n }, () => provider.complete(secret, call('slow')))))
      .map((r) => window.parse(JSON.parse(r.text)))
      .sort((a, b) => a.start - b.start)

  test('at most maxConcurrent children run at once; the rest wait their turn', async () => {
    const provider = new ClaudeCliModelProvider({ bin: FAKE, maxConcurrent: 1 })
    const [a, b, c] = await run(provider, 3)
    expect(b?.start).toBeGreaterThanOrEqual(a?.end ?? Number.POSITIVE_INFINITY)
    expect(c?.start).toBeGreaterThanOrEqual(b?.end ?? Number.POSITIVE_INFINITY)
  })

  test('with room for two, the first two overlap', async () => {
    const provider = new ClaudeCliModelProvider({ bin: FAKE, maxConcurrent: 2 })
    const [a, b, c] = await run(provider, 3)
    expect(b?.start).toBeLessThan(a?.end ?? 0)
    expect(c?.start).toBeGreaterThanOrEqual(Math.min(a?.end ?? 0, b?.end ?? 0))
  })

  test('a call that waits past its deadline for a slot fails with timeout', async () => {
    const provider = new ClaudeCliModelProvider({ bin: FAKE, maxConcurrent: 1, queueTimeoutMs: 50 })
    const first = provider.complete(secret, call('slow'))
    expect(await codeOf(provider.complete(secret, call('slow')))).toBe('timeout')
    await first
  })
})

describe('ClaudeCliModelProvider failures', () => {
  const provider = new ClaudeCliModelProvider({
    bin: FAKE,
    timeoutMs: 400,
    maxStdoutBytes: 100_000,
  })

  test('is_error, with or without a non-zero exit, is unavailable', async () => {
    expect(await codeOf(provider.complete(secret, call('error')))).toBe('unavailable')
    expect(await codeOf(provider.complete(secret, call('error0')))).toBe('unavailable')
  })

  test('a non-zero exit with no output is unavailable', async () => {
    expect(await codeOf(provider.complete(secret, call('exit3')))).toBe('unavailable')
  })

  test('a usage-limit message is subscription_limit', async () => {
    expect(await codeOf(provider.complete(secret, call('limit')))).toBe('subscription_limit')
  })

  test('garbage output is invalid_response', async () => {
    expect(await codeOf(provider.complete(secret, call('garbage')))).toBe('invalid_response')
  })

  test('a hung child is killed at the timeout', async () => {
    const started = Date.now()
    expect(await codeOf(provider.complete(secret, call('hang')))).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test('output past the cap kills the child and is invalid_response', async () => {
    expect(await codeOf(provider.complete(secret, call('big')))).toBe('invalid_response')
  })
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
