import { z } from 'zod'
import {
  type ModelProvider,
  ModelProviderError,
  type ModelRequest,
  type ModelResponse,
  modelRequest,
  type ProviderErrorCode,
  type ProviderSecret,
} from '../ports/model-provider'

/** The slice of `fetch` this adapter uses; tests stub it, so no test touches the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Options for {@link AnthropicModelProvider}. */
export interface AnthropicOptions {
  /** Defaults to global `fetch`. */
  fetch?: FetchLike
  /** API origin; defaults to Anthropic's. */
  baseUrl?: string
  /** Milliseconds before one attempt is abandoned; defaults to 60000. */
  timeoutMs?: number
  /** Attempts per call, first included; defaults to 3. */
  maxAttempts?: number
  /** Backoff base in milliseconds; defaults to 500. */
  backoffMs?: number
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Jitter source in [0, 1); injectable for tests. */
  random?: () => number
}

/** What Anthropic's Messages API returns that this adapter uses (validated at the boundary). */
const reply = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
})

const RETRYABLE: readonly ProviderErrorCode[] = ['rate_limited', 'timeout', 'unavailable']
const MAX_BACKOFF_MS = 10_000

/** Maps an HTTP status to a coded failure. */
function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) {
    return 'unauthorized'
  }
  if (status === 429) {
    return 'rate_limited'
  }
  if (status === 408 || status === 504) {
    return 'timeout'
  }
  if (status >= 500) {
    return 'unavailable'
  }
  return 'invalid_request'
}

/**
 * Anthropic API-key {@link ModelProvider} over `fetch`. Every attempt has a timeout; rate-limit,
 * timeout and 5xx failures are retried a bounded number of times with full-jitter backoff. The
 * reply is Zod-validated; failures carry a code only, never the key or the provider's text.
 */
export class AnthropicModelProvider implements ModelProvider {
  private readonly fetcher: FetchLike
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly backoffMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(options: AnthropicOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init))
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com'
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxAttempts = options.maxAttempts ?? 3
    this.backoffMs = options.backoffMs ?? 500
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms))
    this.random = options.random ?? Math.random
  }

  async complete(credential: ProviderSecret, request: ModelRequest): Promise<ModelResponse> {
    const parsed = modelRequest.safeParse(request)
    if (!parsed.success) {
      throw new ModelProviderError('invalid_request')
    }
    const body = JSON.stringify({
      model: parsed.data.model,
      max_tokens: parsed.data.maxTokens,
      messages: parsed.data.messages,
      ...(parsed.data.system === undefined ? {} : { system: parsed.data.system }),
    })
    let last: ModelProviderError = new ModelProviderError('unavailable')
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.attempt(credential, body)
      } catch (e) {
        if (!(e instanceof ModelProviderError)) {
          throw new ModelProviderError('unavailable')
        }
        last = e
        if (!RETRYABLE.includes(e.code) || attempt === this.maxAttempts) {
          throw e
        }
        const ceiling = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** (attempt - 1))
        await this.sleep(Math.max(1, Math.floor(this.random() * ceiling)))
      }
    }
    throw last
  }

  private async attempt(credential: ProviderSecret, body: string): Promise<ModelResponse> {
    let res: Response
    try {
      res = await this.fetcher(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': credential.reveal(),
          'anthropic-version': '2023-06-01',
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const aborted = e instanceof DOMException && ['TimeoutError', 'AbortError'].includes(e.name)
      throw new ModelProviderError(aborted ? 'timeout' : 'unavailable')
    }
    if (!res.ok) {
      throw new ModelProviderError(codeForStatus(res.status))
    }
    const data = reply.safeParse(await res.json().catch(() => null))
    if (!data.success) {
      throw new ModelProviderError('invalid_response')
    }
    const text = data.data.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
    return {
      text,
      usage: {
        inputTokens: data.data.usage.input_tokens,
        outputTokens: data.data.usage.output_tokens,
      },
    }
  }
}
