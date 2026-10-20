import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const here = import.meta.dir
const envSource = readFileSync(join(here, 'env.ts'), 'utf8')
const runbook = readFileSync(join(here, '../../../docs/runbooks/self-host.md'), 'utf8')

/** Every env key the guildd schemas read: schema fields (`KEY: z.`) and `source.KEY` reads. */
function envKeys(): string[] {
  const keys = new Set<string>()
  for (const m of envSource.matchAll(/^\s+([A-Z][A-Z0-9_]+): (?:z\.|productionFields)/gm)) {
    if (m[1]) {
      keys.add(m[1])
    }
  }
  for (const m of envSource.matchAll(/source\.([A-Z][A-Z0-9_]+)/g)) {
    if (m[1]) {
      keys.add(m[1])
    }
  }
  return [...keys]
}

describe('self-host runbook', () => {
  test('documents every env key guildd reads', () => {
    const keys = envKeys()
    expect(keys.length).toBeGreaterThan(20)
    const missing = keys.filter((key) => !runbook.includes(`\`${key}\``))
    expect(missing).toEqual([])
  })
})
