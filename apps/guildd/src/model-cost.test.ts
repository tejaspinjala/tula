import { expect, test } from 'bun:test'
import { costMicros } from './model-cost'

const price = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 }

test('costs a call from per-million-token prices (worked example: $3 in, $15 out)', () => {
  // 200k input tokens = $0.60, 100k output tokens = $1.50, total $2.10.
  expect(costMicros({ inputTokens: 200_000, outputTokens: 100_000 }, price)).toBe(2_100_000)
})

test('rounds a fractional micro-dollar up and costs nothing for no usage', () => {
  expect(costMicros({ inputTokens: 1, outputTokens: 0 }, price)).toBe(3)
  expect(costMicros({ inputTokens: 1, outputTokens: 0 }, { ...price, inputMicrosPerMTok: 1 })).toBe(
    1
  )
  expect(costMicros({ inputTokens: 0, outputTokens: 0 }, price)).toBe(0)
})
