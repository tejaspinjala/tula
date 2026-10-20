import { expect, test } from 'bun:test'
import { z } from 'zod'
import { ProviderSecret } from '../ports/model-provider'
import { modelProviderContract, type ScriptedReply } from '../ports/model-provider.contract'
import { AnthropicModelProvider, type FetchLike } from './anthropic-model-provider'

const request = {
  model: 'm-1',
  system: 'be brief',
  messages: [{ role: 'user' as const, content: 'hello' }],
  maxTokens: 50,
}

const ok = (text: string, inputTokens = 3, outputTokens = 2) =>
  Response.json({
    content: [{ type: 'text', text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  })

/** Builds a provider over a stubbed fetch that answers from a queue; no network. */
function stubbed(responses: Array<Response | Error>, opts: { timeoutMs?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = responses.shift()
    if (next instanceof Error) {
      throw next
    }
    return next ?? new Response('', { status: 500 })
  }
  const sleeps: number[] = []
  const provider = new AnthropicModelProvider({
    fetch: fetcher,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
    maxAttempts: 3,
    timeoutMs: opts.timeoutMs ?? 1000,
  })
  return { provider, calls, sleeps }
}

const STATUS: Record<string, number> = {
  unauthorized: 401,
  rate_limited: 429,
  unavailable: 503,
  invalid_response: 200,
  timeout: 504,
  invalid_request: 400,
}

modelProviderContract('anthropic (stubbed fetch)', async () => {
  const queue: Array<Response | Error> = []
  const { provider, calls } = stubbed(queue)
  const script = (r: ScriptedReply) => {
    if (r.ok) {
      queue.push(ok(r.text, r.usage.inputTokens, r.usage.outputTokens))
      return
    }
    // A terminal failure repeats across the retry budget.
    for (let i = 0; i < 3; i++) {
      queue.push(
        r.code === 'invalid_response'
          ? Response.json({ nonsense: true })
          : new Response('{}', { status: STATUS[r.code] ?? 500 })
      )
    }
  }
  return { provider, script, backendCalls: () => calls.length }
})

test('sends the key and model to the messages endpoint and parses the reply', async () => {
  const { provider, calls } = stubbed([ok('hello back', 11, 4)])
  const out = await provider.complete(new ProviderSecret('sk-abc'), request)
  expect(out).toEqual({ text: 'hello back', usage: { inputTokens: 11, outputTokens: 4 } })
  expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  const headers = new Headers(calls[0]?.init.headers)
  expect(headers.get('x-api-key')).toBe('sk-abc')
  expect(headers.get('anthropic-version')).toBe('2023-06-01')
  const body = z
    .object({ model: z.string(), max_tokens: z.number(), system: z.string() })
    .parse(JSON.parse(String(calls[0]?.init.body)))
  expect(body).toMatchObject({ model: 'm-1', max_tokens: 50, system: 'be brief' })
})

test('retries a 529-style outage with jittered backoff, then succeeds', async () => {
  const { provider, calls, sleeps } = stubbed([
    new Response('{}', { status: 503 }),
    new Response('{}', { status: 429 }),
    ok('finally'),
  ])
  const out = await provider.complete(new ProviderSecret('k'), request)
  expect(out.text).toBe('finally')
  expect(calls).toHaveLength(3)
  expect(sleeps).toHaveLength(2)
  expect(sleeps.every((ms) => ms > 0)).toBe(true)
})

test('gives up after the retry budget and does not retry an auth failure', async () => {
  const failing = new AnthropicModelProvider({
    fetch: async () => new Response('', { status: 503 }),
    sleep: async () => {},
    random: () => 0,
    maxAttempts: 2,
    timeoutMs: 100,
  })
  await expect(failing.complete(new ProviderSecret('k'), request)).rejects.toMatchObject({
    code: 'unavailable',
  })
  const auth = stubbed([new Response('{}', { status: 401 })])
  await expect(auth.provider.complete(new ProviderSecret('k'), request)).rejects.toMatchObject({
    code: 'unauthorized',
  })
  expect(auth.calls).toHaveLength(1)
})

test('a network error or abort is a timeout/unavailable, retried, and never carries the key', async () => {
  const { provider } = stubbed([
    new DOMException('timed out', 'TimeoutError'),
    new DOMException('timed out', 'TimeoutError'),
    new DOMException('timed out', 'TimeoutError'),
  ])
  await expect(provider.complete(new ProviderSecret('sk-leak'), request)).rejects.toMatchObject({
    code: 'timeout',
  })
})

test('aborting the caller signal cancels the in-flight fetch and is not retried', async () => {
  let calls = 0
  const provider = new AnthropicModelProvider({
    fetch: (_url, init) => {
      calls++
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      })
    },
    sleep: async () => undefined,
    random: () => 0.5,
    maxAttempts: 3,
    timeoutMs: 10_000,
  })
  const controller = new AbortController()
  const pending = provider.complete(new ProviderSecret('sk'), request, controller.signal)
  setTimeout(() => controller.abort(), 20)
  await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  expect(calls).toBe(1)
})
