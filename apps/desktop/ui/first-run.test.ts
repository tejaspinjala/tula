import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = import.meta.dir
const read = (name: string): string => readFileSync(join(dir, name), 'utf8')

/** Every url(...) target in the stylesheet plus every src/href in the page. */
function referencedAssets(): string[] {
  const html = read('index.html')
  const css = read('first-run.css')
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '')
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    refs.push(m[1] ?? '')
  }
  return refs
}

describe('desktop first-run page', () => {
  test('references only local files that exist (CSP is default-src self)', () => {
    const refs = referencedAssets()
    expect(refs.length).toBeGreaterThan(3)
    for (const ref of refs) {
      expect(ref).not.toMatch(/^(?:[a-z]+:)?\/\//i)
      expect(existsSync(join(dir, ref))).toBe(true)
    }
  })

  test('the error line is an alert in the dialogue-box style', () => {
    const html = read('index.html')
    expect(html).toMatch(/id="error"[^>]*role="alert"|role="alert"[^>]*id="error"/)
    expect(html).toContain('class="dialogue')
  })

  test('uses the pixel fonts and no rounded corners', () => {
    const css = read('first-run.css')
    expect(css).toContain('Pixelify Sans')
    expect(css).not.toContain('border-radius')
  })
})

describe('desktop first-run error line', () => {
  type Submit = (event: { preventDefault(): void }) => Promise<void>

  /** Runs first-run.js against a fake page and IPC bridge; resolves to the alert text. */
  async function run(invoke: (() => Promise<void>) | undefined): Promise<string> {
    const error = { textContent: '' }
    let submit: Submit = async () => {}
    const nodes: Record<string, unknown> = {
      address: { value: 'x', focus: () => {} },
      error,
      form: {
        addEventListener: (_type: string, handler: Submit) => {
          submit = handler
        },
      },
    }
    Object.assign(globalThis, {
      document: { getElementById: (id: string) => nodes[id] },
      window: { __TAURI_INTERNALS__: invoke ? { invoke } : undefined },
    })
    new Function(read('first-run.js'))()
    await submit({ preventDefault: () => {} })
    return error.textContent
  }

  test('shows the Rust validation message when set_server_url rejects with a string', async () => {
    const text = await run(() => Promise.reject('That address is not a Guildhall.'))
    expect(text).toBe('That address is not a Guildhall.')
  })

  test('shows an in-world line, never a raw JS error', async () => {
    const text = await run(undefined)
    expect(text).toBe(
      'The Guildhall could not be reached from here. Check the address and try again.'
    )
  })
})
