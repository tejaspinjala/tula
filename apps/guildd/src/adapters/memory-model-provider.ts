import {
  type ModelProvider,
  ModelProviderError,
  type ModelRequest,
  type ModelResponse,
  modelRequest,
  type ProviderErrorCode,
  type ProviderSecret,
} from '../ports/model-provider'

type Scripted =
  | { ok: true; text: string; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; code: ProviderErrorCode }

/** What the scripted backend saw on one call. */
export interface SeenCall {
  request: ModelRequest
  /** The credential the gateway injected, so tests can prove it arrived (test adapter only). */
  credential: string
}

/**
 * Memory {@link ModelProvider}: answers from a script (text and usage per call), in order. An
 * empty script answers `unavailable`. State lives in this instance only.
 */
export class MemoryModelProvider implements ModelProvider {
  /** The vendor this stand-in reports; `Anthropic` unless a test names another. */
  readonly vendor: string

  constructor(vendor = 'Anthropic') {
    this.vendor = vendor
  }

  private readonly queue: Scripted[] = []
  /** Calls that reached the backend, in order. */
  readonly seen: SeenCall[] = []

  /** Queues the answer to the next call. */
  script(reply: Scripted): void {
    this.queue.push(reply)
  }

  async complete(
    credential: ProviderSecret,
    request: ModelRequest,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    if (signal?.aborted) {
      throw new ModelProviderError('aborted')
    }
    const parsed = modelRequest.safeParse(request)
    if (!parsed.success) {
      throw new ModelProviderError('invalid_request')
    }
    this.seen.push({ request: parsed.data, credential: credential.reveal() })
    const next = this.queue.shift()
    if (!next) {
      throw new ModelProviderError('unavailable')
    }
    if (!next.ok) {
      throw new ModelProviderError(next.code)
    }
    return { text: next.text, usage: next.usage }
  }
}
