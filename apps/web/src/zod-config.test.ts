import { expect, test } from 'bun:test'
import { z } from 'zod'
import './zod-config'

test('zod runs jitless so the page needs no unsafe-eval under its CSP', () => {
  expect(z.config().jitless).toBe(true)
})
