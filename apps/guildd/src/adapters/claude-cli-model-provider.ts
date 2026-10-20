import { z } from 'zod'
import {
  type ModelProvider,
  ModelProviderError,
  type ModelRequest,
  type ModelResponse,
  modelRequest,
  type ProviderSecret,
} from '../ports/model-provider'

/** Options for {@link ClaudeCliModelProvider}. */
export interface ClaudeCliOptions {
  /** The `claude` executable; defaults to `claude` on PATH. */
  bin?: string
  /** Milliseconds before the child is killed; defaults to 120000. */
  timeoutMs?: number
  /** Most children at once; defaults to 2. */
  maxConcurrent?: number
  /** Milliseconds a call may wait for a free slot; defaults to the call timeout. */
  queueTimeoutMs?: number
  /** Bytes of stdout kept before the child is killed; defaults to 1 MiB. */
  maxStdoutBytes?: number
  /** Where the allowlisted variables are read from; defaults to `process.env`. */
  env?: Record<string, string | undefined>
}

/** Environment variables the child may inherit. Nothing else: the subscription is the credential. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const

/** What `claude -p --output-format json` prints that this adapter uses (validated at the boundary). */
const cliReply = z.object({
  result: z.string().default(''),
  is_error: z.boolean(),
  subtype: z.string().optional(),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cache_creation_input_tokens: z.number().int().min(0).default(0),
    cache_read_input_tokens: z.number().int().min(0).default(0),
  }),
})

/** The CLI's wording when the subscription's usage window is spent. */
const LIMIT_MESSAGE = /usage limit|limit reached|hit your limit|out of extra usage/i

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Flattens the conversation into the one prompt `claude -p` reads from stdin. */
function promptOf(messages: ModelRequest['messages']): string {
  const [only] = messages
  if (messages.length === 1 && only) {
    return only.content
  }
  return messages
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

/**
 * {@link ModelProvider} that runs the unmodified `claude` binary on the host, so the Guild
 * Master's own signed-in subscription is the credential (ADR-0005, ADR-0008). Guildhall never
 * reads or forwards the OAuth token: the child inherits only an allowlisted environment, the
 * prompt goes on stdin, and the process is spawned from an argv array with no shell. Usage is
 * reported in tokens only; the dollar cost the CLI prints is ignored.
 */
export class ClaudeCliModelProvider implements ModelProvider {
  private readonly bin: string
  private readonly env: Record<string, string>
  private readonly timeoutMs: number
  private readonly maxConcurrent: number
  private readonly queueTimeoutMs: number
  /** Children running now; a per-process limiter that protects the local CLI, not durable state. */
  private running = 0
  private readonly waiters: Array<() => void> = []
  private readonly maxStdoutBytes: number

  constructor(options: ClaudeCliOptions = {}) {
    this.bin = options.bin ?? 'claude'
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2)
    this.queueTimeoutMs = options.queueTimeoutMs ?? this.timeoutMs
    this.maxStdoutBytes = options.maxStdoutBytes ?? 1024 * 1024
    const source = options.env ?? process.env
    const env: Record<string, string> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    for (const key of ENV_ALLOWLIST) {
      const value = source[key]
      if (value !== undefined) {
        env[key] = value
      }
    }
    this.env = env
  }

  /** Takes a slot, waiting up to the queue deadline; rejects with `timeout` past it. */
  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(grant)
        if (at >= 0) {
          this.waiters.splice(at, 1)
        }
        reject(new ModelProviderError('timeout'))
      }, this.queueTimeoutMs)
      this.waiters.push(grant)
    })
  }

  /** Frees a slot, handing it straight to the longest waiter. */
  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.running--
    }
  }

  /** Runs one child to completion: killed at the timeout or when stdout passes its cap. */
  private async run(args: string[], prompt: string): Promise<{ text: string; exitCode: number }> {
    const proc = Bun.spawn([this.bin, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: this.env,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, this.timeoutMs)
    try {
      proc.stdin.write(prompt)
      await proc.stdin.end()
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of proc.stdout) {
        size += chunk.byteLength
        if (size > this.maxStdoutBytes) {
          proc.kill('SIGKILL')
          throw new ModelProviderError('invalid_response')
        }
        chunks.push(chunk)
      }
      const exitCode = await proc.exited
      if (timedOut) {
        throw new ModelProviderError('timeout')
      }
      return { text: Buffer.concat(chunks).toString('utf8'), exitCode }
    } catch (e) {
      if (timedOut) {
        throw new ModelProviderError('timeout')
      }
      throw e instanceof ModelProviderError ? e : new ModelProviderError('unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  async complete(_credential: ProviderSecret, request: ModelRequest): Promise<ModelResponse> {
    const parsed = modelRequest.safeParse(request)
    if (!parsed.success) {
      throw new ModelProviderError('invalid_request')
    }
    const { model, system, messages } = parsed.data
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources',
      '',
      ...(system === undefined ? [] : ['--system-prompt', system]),
      '--model',
      model,
    ]
    await this.acquire()
    let stdout: { text: string; exitCode: number }
    try {
      stdout = await this.run(args, promptOf(messages))
    } finally {
      this.release()
    }
    const data = cliReply.safeParse(parseJson(stdout.text))
    if (data.success && data.data.is_error && LIMIT_MESSAGE.test(data.data.result)) {
      throw new ModelProviderError('subscription_limit')
    }
    if (stdout.exitCode !== 0 || (data.success && data.data.is_error)) {
      throw new ModelProviderError('unavailable')
    }
    if (!data.success) {
      throw new ModelProviderError('invalid_response')
    }
    const { usage } = data.data
    return {
      text: data.data.result,
      usage: {
        inputTokens:
          usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
        outputTokens: usage.output_tokens,
      },
    }
  }
}
