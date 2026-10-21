import { z } from 'zod'

/**
 * A provider credential held as an opaque handle. It cannot be logged, serialised or put in an
 * error by accident: only {@link ProviderSecret.reveal} returns the value, and only an adapter
 * that must put it on the wire calls that.
 */
export class ProviderSecret {
  readonly #value: string

  constructor(value: string) {
    this.#value = value
  }

  /** The raw credential; for an adapter's outbound request only, never for logs or errors. */
  reveal(): string {
    return this.#value
  }

  toString(): string {
    return '[redacted]'
  }

  toJSON(): string {
    return '[redacted]'
  }
}

/** Largest model reply a request may ask for. */
export const MAX_REPLY_TOKENS = 64_000

/** One model call as the gateway sends it. The model id comes from the routing profile in guild config. */
export const modelRequest = z.object({
  model: z.string().min(1).max(200),
  system: z.string().max(200_000).optional(),
  messages: z
    .array(
      z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(400_000) })
    )
    .min(1)
    .max(200),
  maxTokens: z.number().int().min(1).max(MAX_REPLY_TOKENS),
})
/** A model call. */
export type ModelRequest = z.infer<typeof modelRequest>

/** Tokens a call consumed, as the provider reports them. */
export const modelUsage = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
})
/** Token usage of one call. */
export type ModelUsage = z.infer<typeof modelUsage>

/** A model's reply and what it cost in tokens. */
export interface ModelResponse {
  text: string
  usage: ModelUsage
}

/** Why a provider call failed; coded, never provider text. */
export const PROVIDER_ERROR_CODES = [
  'invalid_request',
  'unauthorized',
  'rate_limited',
  'timeout',
  'unavailable',
  'invalid_response',
  /** The Claude subscription's usage limit is reached; not retried. */
  'subscription_limit',
  /** The caller's `AbortSignal` fired (Bar the Gates mid-call); the call was stopped, not retried. */
  'aborted',
] as const
/** One provider failure code. */
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number]

/** Thrown by a {@link ModelProvider}; carries a code only, never the credential or provider text. */
export class ModelProviderError extends Error {
  constructor(readonly code: ProviderErrorCode) {
    super(`model provider failed: ${code}`)
    this.name = 'ModelProviderError'
  }
}

/**
 * Port for a model provider. Adapters validate the request and the provider's reply at the
 * boundary, bound every outbound call with a timeout and jittered retries, and never log the
 * credential or put it in an error.
 */
export interface ModelProvider {
  /** The vendor this adapter's calls reach, shown to the Guild Master in the private-work disclosure. */
  readonly vendor: string
  /**
   * Runs one call; rejects with {@link ModelProviderError}. When `signal` aborts, the call stops
   * and rejects with code `aborted`.
   */
  complete(
    credential: ProviderSecret,
    request: ModelRequest,
    signal?: AbortSignal
  ): Promise<ModelResponse>
}
