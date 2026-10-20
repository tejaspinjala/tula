import { expect, test } from 'bun:test'
import { z } from 'zod'

const manifest = z.object({
  name: z.string().min(1),
  start_url: z.string(),
  display: z.enum(['standalone', 'fullscreen', 'minimal-ui']),
  icons: z.array(z.object({ src: z.string(), sizes: z.string(), type: z.string() })).min(1),
})

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text()

test('the web manifest makes the ledger view installable', async () => {
  const parsed = manifest.parse(JSON.parse(await read('../public/manifest.webmanifest')))
  expect(parsed.display).toBe('standalone')
  for (const icon of parsed.icons) {
    expect(await Bun.file(new URL(`../public${icon.src}`, import.meta.url)).exists()).toBe(true)
  }
})

test('the page links the manifest and registers the service worker', async () => {
  expect(await read('../index.html')).toContain('rel="manifest" href="/manifest.webmanifest"')
  expect(await read('./main.tsx')).toContain("serviceWorker.register('/sw.js')")
})

test('the shell has a skip link, landmarks and visible focus', async () => {
  const app = await read('./App.tsx')
  expect(app).toContain('href="#main"')
  expect(app).toContain('<main id="main"')
  expect(await read('./Shell.tsx')).toContain('<nav aria-label="Ledger"')
  expect(await read('./index.css')).toContain(':focus-visible')
})
