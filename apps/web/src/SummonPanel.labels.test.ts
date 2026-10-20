import { expect, test } from 'bun:test'
import { STEP_LABELS } from './SummonPanel'

// The provider step is done for an api_key provider or an enabled subscription provider (#64).
test('the provider step names both an API key and a Claude subscription', () => {
  expect(STEP_LABELS.provider).toMatch(/API key/)
  expect(STEP_LABELS.provider).toMatch(/subscription/)
})
