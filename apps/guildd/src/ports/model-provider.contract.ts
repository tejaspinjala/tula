import { describe, expect, test } from 'bun:test'
import {
  type ModelProvider,
  ModelProviderError,
  type ModelRequest,
  type ProviderErrorCode,
  ProviderSecret,
} from './model-provider'

/** A scripted reply the fixture arranges for the provider's next call. */
export type ScriptedReply =
  | { ok: true; text: string; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; code: ProviderErrorCode }

/** A provider under test, with a way to script what it answers next. */
export interface ModelProviderFixture {
  provider: ModelProvider
  script: (reply: ScriptedReply) => void
  /** How many calls reached the (scripted) backend. */
  backendCalls: () => number
}

const SECRET = 'sk-test-super-secret-value'
const request: ModelRequest = {
  model: 'any-model',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 100,
}

async function failure(p: Promise<unknown>): Promise<ModelProviderError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ModelProviderError) {
      return e
    }
    throw e
  }
  throw new Error('expected the call to fail')
}

/** The ModelProvider contract, run against every adapter. `make` returns a fresh provider. */
export function modelProviderContract(name: string, make: () => Promise<ModelProviderFixture>) {
  describe(`ModelProvider contract: ${name}`, () => {
    test('returns the reply text and the reported usage', async () => {
      const { provider, script } = await make()
      script({ ok: true, text: 'hi there', usage: { inputTokens: 12, outputTokens: 7 } })
      const out = await provider.complete(new ProviderSecret(SECRET), request)
      expect(out).toEqual({ text: 'hi there', usage: { inputTokens: 12, outputTokens: 7 } })
    })

    test('a provider refusal rejects with its code and never leaks the credential', async () => {
      const { provider, script } = await make()
      script({ ok: false, code: 'unauthorized' })
      const err = await failure(provider.complete(new ProviderSecret(SECRET), request))
      expect(err.code).toBe('unauthorized')
      expect(`${err.message} ${err.stack ?? ''} ${JSON.stringify(err)}`).not.toContain(SECRET)
    })

    test('an invalid request is refused before any backend call', async () => {
      const f = await make()
      const err = await failure(
        f.provider.complete(new ProviderSecret(SECRET), { ...request, messages: [] })
      )
      expect(err.code).toBe('invalid_request')
      expect(f.backendCalls()).toBe(0)
    })

    test('a credential cannot be serialised by accident', () => {
      const secret = new ProviderSecret(SECRET)
      expect(`${secret} ${JSON.stringify({ secret })}`).not.toContain(SECRET)
    })
  })
}
