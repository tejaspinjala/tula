import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Glob } from 'bun'

const SRC = import.meta.dir
const GLOSSARY = resolve(SRC, '../../../GLOSSARY.md')

/** Event type literals passed straight to `appendEvent(tx, keys, '<type>', ...)`. */
async function appendedTypes(): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for await (const file of new Glob('**/*.ts').scan({ cwd: SRC })) {
    if (file.endsWith('.test.ts') || file.includes('testing/')) {
      continue
    }
    const text = await Bun.file(resolve(SRC, file)).text()
    for (const m of text.matchAll(/appendEvent\(\s*[\w.]+,\s*[\w.]+,\s*'([a-z_]+\.[a-z_]+)'/g)) {
      found.set(m[1] ?? '', file)
    }
  }
  return found
}

test('every event type appendEvent writes by literal is defined in GLOSSARY.md', async () => {
  const glossary = await Bun.file(GLOSSARY).text()
  const types = await appendedTypes()
  expect(types.size).toBeGreaterThan(5)
  const missing = [...types].filter(
    ([type]) =>
      !glossary.includes(`**${type}**`) &&
      !glossary.includes(`**${type}** /`) &&
      !glossary.includes(`/ **${type}**`)
  )
  expect(missing.map(([type, file]) => `${type} (${file})`)).toEqual([])
})
