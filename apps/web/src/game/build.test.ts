import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const webRoot = join(import.meta.dir, '..', '..')
const srcRoot = join(import.meta.dir, '..')

test('the lazy-load boundary: only game/start.ts and HallScene.ts import Phaser, and the page reaches them by dynamic import()', () => {
  const importsPhaser: string[] = []
  const staticStart: string[] = []
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
    )
  for (const file of walk(srcRoot).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))) {
    const text = readFileSync(file, 'utf8')
    if (/from ['"]phaser['"]|import\(['"]phaser['"]\)/.test(text)) {
      importsPhaser.push(file.slice(srcRoot.length + 1))
    }
    if (/^import (?!type ).* from ['"].*game\/(start|HallScene)['"]/m.test(text)) {
      staticStart.push(file.slice(srcRoot.length + 1))
    }
  }
  expect(importsPhaser.sort()).toEqual(['game/HallScene.ts', 'game/start.ts'])
  expect(staticStart).toEqual([])
  expect(readFileSync(join(srcRoot, 'GamePanel.tsx'), 'utf8')).toContain("import('./game/start')")
})

test('the production build keeps Phaser out of the main bundle and ships no eval or Function constructor', async () => {
  const out = mkdtempSync(join(tmpdir(), 'guildhall-web-build-'))
  try {
    const build = Bun.spawn(['bunx', 'vite', 'build', '--outDir', out, '--emptyOutDir'], {
      cwd: webRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await build.exited).toBe(0)
    const assets = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'))
    const html = readFileSync(join(out, 'index.html'), 'utf8')
    const entry = assets.find((f) => html.includes(f))
    expect(entry).toBeDefined()
    const texts = new Map(assets.map((f) => [f, readFileSync(join(out, 'assets', f), 'utf8')]))
    const entryText = entry ? (texts.get(entry) ?? '') : ''
    expect(entryText).not.toContain('WebGLRenderer')
    // The game ships as its own chunk, loaded on demand.
    const gameChunks = assets.filter((f) => (texts.get(f) ?? '').includes('WebGLRenderer'))
    expect(gameChunks.length).toBeGreaterThan(0)
    expect(html).not.toContain(gameChunks[0] ?? '\0')
    // A strict CSP (no unsafe-eval) forbids both; the browser run checks the live page too.
    for (const [, text] of texts) {
      expect(text).not.toMatch(/\beval\(/)
      expect(text).not.toMatch(/new Function\(/)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}, 120_000)
